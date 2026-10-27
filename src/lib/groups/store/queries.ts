/// <reference types="@cloudflare/workers-types" />
// Every SQL text the DRep groups store, jobs and page readers run, by name, so one check
// can inspect how SQLite executes each of them.
import { DB_NOW_MS } from '../../db/sql.js';
import { LEASE_MS } from '../constants.js';

export interface RegisteredQuery {
  sql: string;
  /** The index a keyset read with ORDER BY and LIMIT may scan. */
  boundedScan?: string;
}

const LIVE_LEASE = `id = 1 AND token = ? AND expires_at > ${DB_NOW_MS}`;

/** A VALUES list of `rows` tuples of `width` placeholders. */
const values = (width: number, rows: number): string =>
  Array.from({ length: rows }, () => `(${Array.from({ length: width }, () => '?').join(', ')})`).join(', ');

const MAX = Number.MAX_SAFE_INTEGER;

// Statements over a VALUES list of keys, built per chunk length. The registry holds the one row text.
export const KEYED = Object.freeze({
  loadInstances: (n: number) => `WITH k(tx, ix) AS (VALUES ${values(2, n)})
    SELECT k.tx AS k_tx, k.ix AS k_ix, i.* FROM k
    LEFT JOIN drep_group_instances i ON i.join_tx = k.tx AND i.join_ix = k.ix`,
  loadLatestInstances: (n: number) => `WITH k(gtx, gix, cred) AS (VALUES ${values(3, n)})
    SELECT k.gtx AS k_gtx, k.gix AS k_gix, k.cred AS k_cred, i.* FROM k
    LEFT JOIN drep_group_instances i ON i.rowid = (
      SELECT x.rowid FROM drep_group_instances x
      WHERE x.group_tx = k.gtx AND x.group_ix = k.gix AND x.cred = k.cred
      ORDER BY x.joined_h DESC, x.joined_ti DESC, x.joined_ph DESC, x.joined_ix DESC LIMIT 1)`,
  // The latest version at or before the position, and the group's dissolve version.
  loadGroupsAt: (n: number) => `WITH k(gtx, gix, h, ti, ph, ix) AS (VALUES ${values(6, n)})
    SELECT k.gtx AS k_gtx, k.gix AS k_gix, k.h AS k_h, k.ti AS k_ti, k.ph AS k_ph, k.ix AS k_ix, v.*,
      d.at_h AS dis_h, d.at_ti AS dis_ti, d.at_ph AS dis_ph, d.at_ix AS dis_ix, d.at_tx AS dis_tx
    FROM k
    LEFT JOIN drep_group_versions v ON v.rowid = (
      SELECT x.rowid FROM drep_group_versions x
      WHERE x.group_tx = k.gtx AND x.group_ix = k.gix AND (x.at_h, x.at_ti, x.at_ph, x.at_ix) <= (k.h, k.ti, k.ph, k.ix)
      ORDER BY x.at_h DESC, x.at_ti DESC, x.at_ph DESC, x.at_ix DESC LIMIT 1)
    LEFT JOIN drep_group_versions d ON d.rowid = (
      SELECT y.rowid FROM drep_group_versions y
      WHERE y.group_tx = k.gtx AND y.group_ix = k.gix AND y.status = 'dissolved' LIMIT 1)`,
  loadScriptsAt: (n: number) => `WITH k(hash, h, ti, ph, ix) AS (VALUES ${values(5, n)})
    SELECT k.hash AS k_hash, k.h AS k_h, k.ti AS k_ti, k.ph AS k_ph, k.ix AS k_ix, s.bytes FROM k
    LEFT JOIN drep_group_scripts s ON s.hash = k.hash AND (s.at_h, s.at_ti, s.at_ph, s.at_ix) <= (k.h, k.ti, k.ph, k.ix)`,
  // A ledger row sits at (block_height, tx_index, 0, cert_index). Phase 0 is the lowest, so against
  // a position of a later phase the cert index bound is MAX, which keeps both comparisons on the index.
  loadCredentialsAt: (n: number) => `WITH k(cred, h, ti, ph, ix) AS (VALUES ${values(5, n)}),
    b AS (SELECT cred, h, ti, ph, ix, CASE WHEN ph = 0 THEN ix ELSE ${MAX} END AS cix FROM k)
    SELECT b.cred AS k_cred, b.h AS k_h, b.ti AS k_ti, b.ph AS k_ph, b.ix AS k_ix,
      (SELECT l.kind FROM drep_group_ledger l
        WHERE l.cred = b.cred AND (l.block_height, l.tx_index, l.cert_index) <= (b.h, b.ti, b.cix)
        ORDER BY l.block_height DESC, l.tx_index DESC, l.cert_index DESC LIMIT 1) AS last_kind,
      u.block_height AS u_h, u.tx_index AS u_ti, u.cert_index AS u_ix, u.tx_hash AS u_tx,
      m.bytes AS m_bytes
    FROM b
    LEFT JOIN drep_group_ledger u ON u.rowid = (
      SELECT l.rowid FROM drep_group_ledger l
      WHERE l.cred = b.cred AND l.kind = 'unreg' AND (l.block_height, l.tx_index, l.cert_index) > (b.h, b.ti, b.cix)
      ORDER BY l.block_height, l.tx_index, l.cert_index LIMIT 1)
    LEFT JOIN drep_group_member_scripts m ON m.cred = b.cred
      AND (m.at_h, m.at_ti, m.at_ph, m.at_ix) <= (b.h, b.ti, b.ph, b.ix)`,
  queuedJoins: (n: number) => `WITH k(tx, ix) AS (VALUES ${values(2, n)})
    SELECT k.tx AS k_tx, k.ix AS k_ix, q.event_json, t.marker FROM k
    LEFT JOIN drep_group_queue q ON q.tx_hash = k.tx AND q.idx = k.ix
    LEFT JOIN drep_group_txs t ON t.tx_hash = k.tx AND t.marker = 1`,
  txContexts: (n: number) => `WITH k(tx) AS (VALUES ${values(1, n)})
    SELECT c.* FROM k JOIN drep_group_tx_context c ON c.tx_hash = k.tx`,
});

/** Bound parameters per key of each keyed statement. */
export const KEYED_WIDTH: Readonly<Record<keyof typeof KEYED, number>> = Object.freeze({
  loadInstances: 2,
  loadLatestInstances: 3,
  loadGroupsAt: 6,
  loadScriptsAt: 5,
  loadCredentialsAt: 5,
  queuedJoins: 2,
  txContexts: 1,
});

const LABEL_TX_RANGE = 'marker = 0 AND (block_height, tx_index) >= (?, ?) AND block_height <= ?';
const READY_TRACKED = `SELECT cred, applied_h, applied_ti, applied_ph, applied_ix, applied_tx,
    next_h, next_ti, next_ph, next_ix, next_tx
  FROM drep_group_tracked
  WHERE complete = 1 AND known = ? AND next_h IS NOT NULL AND (next_h, next_ti, next_ph, next_ix) <= (?, ?, ?, ?)
  ORDER BY next_h, next_ti, next_ph, next_ix LIMIT ?`;

export const Q = Object.freeze({
  leaseSeed: {
    sql: 'INSERT OR IGNORE INTO drep_group_lease (id, owner, token, expires_at) VALUES (1, NULL, NULL, 0)',
  },
  // Binds owner, token, owner. Takes an expired lease, or renews a live one of the same owner.
  leaseTake: {
    sql: `UPDATE drep_group_lease SET owner = ?, token = ?, expires_at = ${DB_NOW_MS} + ${LEASE_MS}
          WHERE id = 1 AND (expires_at <= ${DB_NOW_MS} OR owner = ?)`,
  },
  leaseToken: { sql: 'SELECT token FROM drep_group_lease WHERE id = 1' },
  leaseRelease: { sql: 'UPDATE drep_group_lease SET expires_at = 0 WHERE id = 1 AND token = ?' },
  leaseGuard: {
    sql: `INSERT INTO drep_group_lease_check (ok)
          SELECT CASE WHEN EXISTS (SELECT 1 FROM drep_group_lease WHERE ${LIVE_LEASE}) THEN 1 ELSE 0 END`,
  },
  leaseGuardEnd: { sql: 'DELETE FROM drep_group_lease_check' },
  loadInstances: { sql: KEYED.loadInstances(1) },
  loadLatestInstances: { sql: KEYED.loadLatestInstances(1) },
  loadGroupsAt: { sql: KEYED.loadGroupsAt(1) },
  loadScriptsAt: { sql: KEYED.loadScriptsAt(1) },
  loadCredentialsAt: { sql: KEYED.loadCredentialsAt(1) },
  queuedJoins: { sql: KEYED.queuedJoins(1) },
  txContexts: { sql: KEYED.txContexts(1) },
  // Binds the first (height, tx index) to return, the height L and the page size.
  labelTxPage: {
    sql: `SELECT * FROM drep_group_txs WHERE ${LABEL_TX_RANGE} ORDER BY block_height, tx_index LIMIT ?`,
    boundedScan: 'drep_group_txs_label',
  },
  labelTxProbe: {
    sql: `SELECT 1 AS hit FROM drep_group_txs WHERE ${LABEL_TX_RANGE} ORDER BY block_height, tx_index LIMIT 1`,
    boundedScan: 'drep_group_txs_label',
  },
  // Binds known (0 or 1), the bound position and the limit.
  readyTracked: { sql: READY_TRACKED, boundedScan: 'drep_group_tracked_ready' },
  // Binds the subject, the applied position (exclusive) and the bound (inclusive), then the limit.
  queueInputs: {
    sql: `SELECT * FROM drep_group_queue
          WHERE subject = ? AND applied = 0
            AND (at_h, at_ti, at_ph, at_ix) > (?, ?, ?, ?) AND (at_h, at_ti, at_ph, at_ix) <= (?, ?, ?, ?)
          ORDER BY at_h, at_ti, at_ph, at_ix LIMIT ?`,
    boundedScan: 'drep_group_queue_subject',
  },
  // Binds the credential, the applied bound (exclusive) and the upper bound (inclusive) as
  // (height, tx index, cert index) triples, then the limit.
  ledgerInputs: {
    sql: `SELECT * FROM drep_group_ledger
          WHERE cred = ? AND (block_height, tx_index, cert_index) > (?, ?, ?)
            AND (block_height, tx_index, cert_index) <= (?, ?, ?)
          ORDER BY block_height, tx_index, cert_index LIMIT ?`,
    boundedScan: 'drep_group_ledger_cred',
  },
  frontiers: {
    sql: `SELECT L, R, G_h, G_ti, G_ph, G_ix, G_tx,
            (SELECT MIN(block_height) FROM drep_group_txs WHERE refetch = 1) AS refetch_h
          FROM drep_group_meta WHERE id = 1`,
  },
  pendingRecovery: { sql: 'SELECT rec_first_kind, rec_first_above FROM drep_group_meta WHERE id = 1' },
} satisfies Record<string, RegisteredQuery>);

/** Sample binds per query, placeholders only, for the query plan check. */
export const Q_SAMPLE_BINDS: Readonly<Record<keyof typeof Q, unknown[]>> = Object.freeze({
  leaseSeed: [],
  leaseTake: ['owner', 'token', 'owner'],
  leaseToken: [],
  leaseRelease: ['token'],
  leaseGuard: ['token'],
  leaseGuardEnd: [],
  loadInstances: ['tx', 0],
  loadLatestInstances: ['tx', 0, 'key:00'],
  loadGroupsAt: ['tx', 0, 1, 0, 2, 0],
  loadScriptsAt: ['hash', 1, 0, 2, 0],
  loadCredentialsAt: ['key:00', 1, 0, 2, 0],
  queuedJoins: ['tx', 0],
  txContexts: ['tx'],
  labelTxPage: [1, 0, 2, 10],
  labelTxProbe: [1, 0, 2],
  readyTracked: [1, 1, 0, 2, 0, 10],
  queueInputs: ['key:00', 1, 0, 2, 0, 2, 0, 2, 0, 10],
  ledgerInputs: ['key:00', 1, 0, 0, 2, 0, 0, 10],
  frontiers: [],
  pendingRecovery: [],
});
