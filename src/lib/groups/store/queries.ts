/// <reference types="@cloudflare/workers-types" />
// Every SQL text the DRep groups store, jobs and page readers run, by name, so one check
// can inspect how SQLite executes each of them.
import { DB_NOW_MS } from '../../db/sql.js';
import { LEASE_MS, LISTED_MIN_MEMBERS } from '../constants.js';

export interface RegisteredQuery {
  sql: string;
  /** The index a keyset read with ORDER BY and LIMIT may scan. */
  boundedScan?: string;
}

const LIVE_LEASE = `id = 1 AND token = ? AND expires_at > ${DB_NOW_MS}`;

/** A VALUES list of `rows` tuples of `width` placeholders. */
export const values = (width: number, rows: number): string =>
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

const POS = (p: string): string => `${p}_h, ${p}_ti, ${p}_ph, ${p}_ix, ${p}_tx`;
const VERSION_COLS = `group_tx, group_ix, ${POS('at')}, mode, control, admission, profile_url, profile_hash, seq, status,
  ${POS('created')}, ${POS('profile_set')}`;
const INSTANCE_COLS = `join_tx, join_ix, group_tx, group_ix, cred, drep_id, mode, ${POS('joined')}, ${POS('approved')},
  ${POS('closed')}, close_reason, counted_as, ${POS('eff')}, eff_reason`;
// The gen guard of a publication: a NULL bind accepts any gen.
const GEN_OK = (alias: string): string => `${alias}.gen = COALESCE(?, ${alias}.gen)`;
const dissolvedCase = (c: string): string => `CASE WHEN excluded.status = 'dissolved' THEN excluded.cur_${c} ELSE dissolved_${c} END`;
const GROUP_KEY = 'g.group_tx = k.gtx AND g.group_ix = k.gix';
const deleteDue = (kinds: string) => (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    DELETE FROM drep_group_due WHERE rowid IN (
      SELECT d.rowid FROM k JOIN drep_groups g ON ${GROUP_KEY} AND ${GEN_OK('g')}
      JOIN drep_group_due d ON d.kind IN (${kinds}) AND d.group_tx = k.gtx AND d.group_ix = k.gix)`;

// Statements of an engine commit and its pre-read over a VALUES list of rows, built per chunk length.
export const COMMIT = Object.freeze({
  // Pre-read: the stored group row and the dissolve version of each group.
  preGroups: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    SELECT k.gtx AS k_gtx, k.gix AS k_gix, g.group_tx, g.members, g.profile_url, g.profile_hash,
      d.at_h AS dis_h, d.at_ti AS dis_ti, d.at_ph AS dis_ph, d.at_ix AS dis_ix, d.at_tx AS dis_tx
    FROM k
    LEFT JOIN drep_groups g ON ${GROUP_KEY}
    LEFT JOIN drep_group_versions d ON d.rowid = (
      SELECT y.rowid FROM drep_group_versions y
      WHERE y.group_tx = k.gtx AND y.group_ix = k.gix AND y.status = 'dissolved' LIMIT 1)`,
  // Pre-read: the first unreg of the member strictly after its join and at or below its applied
  // position, on the partial unreg index. Cert bounds as in loadCredentialsAt.
  preFirstUnreg: (n: number) => `WITH k(tx, ix, cred, jh, jti, jph, jix, ah, ati, aph, aix) AS (VALUES ${values(11, n)}),
    b AS (SELECT tx, ix, cred, jh, jti, CASE WHEN jph = 0 THEN jix ELSE ${MAX} END AS jc,
      ah, ati, CASE WHEN aph = 0 THEN aix ELSE ${MAX} END AS ac FROM k)
    SELECT b.tx AS k_tx, b.ix AS k_ix, u.block_height AS u_h, u.tx_index AS u_ti, u.cert_index AS u_ix, u.tx_hash AS u_tx
    FROM b
    LEFT JOIN drep_group_ledger u ON u.rowid = (
      SELECT l.rowid FROM drep_group_ledger l
      WHERE l.cred = b.cred AND l.kind = 'unreg'
        AND (l.block_height, l.tx_index, l.cert_index) > (b.jh, b.jti, b.jc)
        AND (l.block_height, l.tx_index, l.cert_index) <= (b.ah, b.ati, b.ac)
      ORDER BY l.block_height, l.tx_index, l.cert_index LIMIT 1)`,
  preVerdicts: (n: number) => `WITH k(tx, ix) AS (VALUES ${values(2, n)})
    SELECT v.tx_hash, v.idx FROM k JOIN drep_group_verdicts v ON v.tx_hash = k.tx AND v.idx = k.ix`,
  insertScripts: (n: number) =>
    `INSERT OR IGNORE INTO drep_group_scripts (hash, ${POS('at')}, bytes, display_json) VALUES ${values(8, n)}`,
  insertMemberScripts: (n: number) =>
    `INSERT OR IGNORE INTO drep_group_member_scripts (cred, ${POS('at')}, bytes, display_json) VALUES ${values(8, n)}`,
  upsertVersions: (n: number) => `INSERT OR REPLACE INTO drep_group_versions (${VERSION_COLS}) VALUES ${values(24, n)}`,
  // The group row from its stored version. A create inserts the counters at 0, a later version
  // writes the version fields only, never a counter and never gen.
  upsertGroups: (n: number) => `WITH k(gtx, gix, gid, h, ti, ph, ix) AS (VALUES ${values(7, n)})
    INSERT INTO drep_groups (group_tx, group_ix, group_id, ${POS('cur')}, mode, control, admission, profile_url,
      profile_hash, seq, status, ${POS('created')}, ${POS('profile_set')}, ${POS('dissolved')}, closing)
    SELECT v.group_tx, v.group_ix, k.gid, v.at_h, v.at_ti, v.at_ph, v.at_ix, v.at_tx, v.mode, v.control, v.admission,
      v.profile_url, v.profile_hash, v.seq, v.status, ${POS('v.created')}, ${POS('v.profile_set')},
      ${['h', 'ti', 'ph', 'ix', 'tx'].map((c) => `CASE WHEN v.status = 'dissolved' THEN v.at_${c} END`).join(', ')},
      CASE WHEN v.status = 'dissolved' THEN 1 ELSE 0 END
    FROM k JOIN drep_group_versions v ON v.group_tx = k.gtx AND v.group_ix = k.gix
      AND v.at_h = k.h AND v.at_ti = k.ti AND v.at_ph = k.ph AND v.at_ix = k.ix
    WHERE true
    ON CONFLICT (group_tx, group_ix) DO UPDATE SET
      cur_h = excluded.cur_h, cur_ti = excluded.cur_ti, cur_ph = excluded.cur_ph, cur_ix = excluded.cur_ix,
      cur_tx = excluded.cur_tx, mode = excluded.mode, control = excluded.control, admission = excluded.admission,
      profile_url = excluded.profile_url, profile_hash = excluded.profile_hash, seq = excluded.seq, status = excluded.status,
      created_h = excluded.created_h, created_ti = excluded.created_ti, created_ph = excluded.created_ph,
      created_ix = excluded.created_ix, created_tx = excluded.created_tx,
      profile_set_h = excluded.profile_set_h, profile_set_ti = excluded.profile_set_ti,
      profile_set_ph = excluded.profile_set_ph, profile_set_ix = excluded.profile_set_ix,
      profile_set_tx = excluded.profile_set_tx,
      ${['h', 'ti', 'ph', 'ix', 'tx'].map((c) => `dissolved_${c} = ${dissolvedCase(c)}`).join(', ')},
      closing = CASE WHEN excluded.status = 'dissolved' THEN 1 ELSE closing END
    WHERE (excluded.cur_h, excluded.cur_ti, excluded.cur_ph, excluded.cur_ix)
      >= (drep_groups.cur_h, drep_groups.cur_ti, drep_groups.cur_ph, drep_groups.cur_ix)`,
  // Binds the rows, then now. A listed group's profile is due at once.
  dueProfileIfListed: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at)
    SELECT 'profile', g.group_tx, g.group_ix, ? FROM k JOIN drep_groups g ON ${GROUP_KEY}
    WHERE g.members >= ${LISTED_MIN_MEMBERS}
    ON CONFLICT (kind, group_tx, group_ix) DO UPDATE SET due_at = excluded.due_at`,
  // Binds the rows, then now and the gen guard. A group that becomes listed with an anchor.
  dueProfileIfAnchored: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at)
    SELECT 'profile', g.group_tx, g.group_ix, ? FROM k JOIN drep_groups g ON ${GROUP_KEY}
    WHERE g.profile_url IS NOT NULL AND ${GEN_OK('g')}
    ON CONFLICT (kind, group_tx, group_ix) DO UPDATE SET due_at = excluded.due_at`,
  // Binds the rows, then the gen guard.
  deleteWebsiteDue: deleteDue("'website'"),
  deleteAllDue: deleteDue("'profile', 'website'"),
  // Binds the rows (kind, key, group, trigger position or NULLs), then the gen guard.
  enqueueGroupJobs: (n: number) => `WITH k(kind, key, gtx, gix, h, ti, ph, ix, tx) AS (VALUES ${values(9, n)})
    INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, group_tx, group_ix, ${POS('trigger')})
    SELECT k.kind, k.key, k.gtx, k.gix, k.h, k.ti, k.ph, k.ix, k.tx FROM k JOIN drep_groups g ON ${GROUP_KEY}
    WHERE ${GEN_OK('g')}`,
  enqueueRetireJobs: (n: number) => `WITH k(key, cred, h, ti, ph, ix, tx) AS (VALUES ${values(7, n)})
    INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, cred, ${POS('trigger')})
    SELECT 'retire', k.key, k.cred, k.h, k.ti, k.ph, k.ix, k.tx FROM k WHERE true`,
  // The only writer of members. Binds the rows (group, delta), then the gen guard.
  publishMembers: (n: number) => `WITH d(gtx, gix, dm) AS (VALUES ${values(3, n)})
    UPDATE drep_groups SET members = members + d.dm, gen = gen + 1
    FROM d WHERE drep_groups.group_tx = d.gtx AND drep_groups.group_ix = d.gix AND ${GEN_OK('drep_groups')}`,
  // Every other counter of a touched group, and its single gen increment unless members owns it.
  groupDeltas: (n: number) => `WITH d(gtx, gix, dp, df, da, dn, dg) AS (VALUES ${values(7, n)})
    UPDATE drep_groups SET pending = pending + d.dp, former = former + d.df,
      applied_events = applied_events + d.da, not_applied_events = not_applied_events + d.dn, gen = gen + d.dg
    FROM d WHERE drep_groups.group_tx = d.gtx AND drep_groups.group_ix = d.gix`,
  upsertInstances: (n: number) => `INSERT OR REPLACE INTO drep_group_instances (${INSTANCE_COLS}) VALUES ${values(30, n)}`,
  insertVerdicts: (n: number) => `INSERT OR IGNORE INTO drep_group_verdicts (tx_hash, idx, group_tx, group_ix, ${POS('at')},
      tag, valid, reason, subject) VALUES ${values(13, n)}`,
  upsertTrimDue: (n: number) => `INSERT INTO drep_group_trim_due (group_tx, group_ix, oldest_h) VALUES ${values(3, n)}
    ON CONFLICT (group_tx, group_ix) DO UPDATE SET oldest_h = MIN(oldest_h, excluded.oldest_h)`,
  insertQueue: (n: number) => `INSERT OR IGNORE INTO drep_group_queue (tx_hash, idx, subject, ${POS('at')}, group_tx,
      group_ix, event_json) VALUES ${values(11, n)}`,
  // Lowers next to an entry that is earlier and still after the applied cursor.
  lowerNext: (n: number) => `WITH d(cred, h, ti, ph, ix, tx) AS (VALUES ${values(6, n)})
    UPDATE drep_group_tracked SET next_h = d.h, next_ti = d.ti, next_ph = d.ph, next_ix = d.ix, next_tx = d.tx
    FROM d WHERE drep_group_tracked.cred = d.cred
      AND (next_h IS NULL OR (next_h, next_ti, next_ph, next_ix) > (d.h, d.ti, d.ph, d.ix))
      AND (applied_h IS NULL OR (d.h, d.ti, d.ph, d.ix) > (applied_h, applied_ti, applied_ph, applied_ix))`,
  // Height and tx index come from the stored label tx. A context of a tx that is not stored
  // fails the NOT NULL constraint and with it the batch.
  insertTxContexts: (n: number) => `WITH k(tx, signers, req, ib, ih) AS (VALUES ${values(5, n)})
    INSERT INTO drep_group_tx_context (tx_hash, block_height, tx_index, signers, required_signers, invalid_before,
      invalid_hereafter)
    SELECT k.tx, t.block_height, t.tx_index, k.signers, k.req, k.ib, k.ih
    FROM k LEFT JOIN drep_group_txs t ON t.tx_hash = k.tx
    WHERE true
    ON CONFLICT (tx_hash) DO NOTHING`,
  markApplied: (n: number) =>
    `UPDATE drep_group_queue SET applied = 1 WHERE (tx_hash, idx) IN (VALUES ${values(2, n)})`,
  retireCredentials: (n: number) => `WITH d(cred, h, ti, ph, ix, tx) AS (VALUES ${values(6, n)})
    UPDATE drep_group_tracked SET retiring = 1, retired_at_h = d.h, retired_at_ti = d.ti, retired_at_ph = d.ph,
      retired_at_ix = d.ix, retired_at_tx = d.tx
    FROM d WHERE drep_group_tracked.cred = d.cred`,
});

/** Bound parameters per row of each commit statement. */
export const COMMIT_WIDTH: Readonly<Record<keyof typeof COMMIT, number>> = Object.freeze({
  preGroups: 2,
  preFirstUnreg: 11,
  preVerdicts: 2,
  insertScripts: 8,
  insertMemberScripts: 8,
  upsertVersions: 24,
  upsertGroups: 7,
  dueProfileIfListed: 2,
  dueProfileIfAnchored: 2,
  deleteWebsiteDue: 2,
  deleteAllDue: 2,
  enqueueGroupJobs: 9,
  enqueueRetireJobs: 7,
  publishMembers: 3,
  groupDeltas: 7,
  upsertInstances: 30,
  insertVerdicts: 13,
  upsertTrimDue: 3,
  insertQueue: 11,
  lowerNext: 6,
  insertTxContexts: 5,
  markApplied: 2,
  retireCredentials: 6,
});

/** Binds that follow the rows of a commit statement. */
export const COMMIT_TRAILING: Readonly<Partial<Record<keyof typeof COMMIT, number>>> = Object.freeze({
  dueProfileIfListed: 1,
  dueProfileIfAnchored: 2,
  deleteWebsiteDue: 1,
  deleteAllDue: 1,
  enqueueGroupJobs: 1,
  publishMembers: 1,
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
  ...(Object.fromEntries(
    (Object.keys(COMMIT) as Array<keyof typeof COMMIT>).map((k) => [k, { sql: COMMIT[k](1) }]),
  ) as Record<keyof typeof COMMIT, RegisteredQuery>),
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
  // Binds the five G columns, then the order columns of the same position to compare with END(L).
  groupCursor: {
    sql: `UPDATE drep_group_meta SET G_h = ?, G_ti = ?, G_ph = ?, G_ix = ?, G_tx = ?,
            rebuilding = CASE WHEN rec_first_kind IS NULL AND (?, ?, ?, ?) = (L, ${MAX}, 2, ${MAX}) THEN 0 ELSE rebuilding END
          WHERE id = 1`,
  },
  // Binds the applied position, the credential and the applied order columns for the queue,
  // the credential and the applied cert bound for the ledger, then the credential.
  credentialCursor: {
    sql: `UPDATE drep_group_tracked SET applied_h = ?, applied_ti = ?, applied_ph = ?, applied_ix = ?, applied_tx = ?,
            gen = gen + 1,
            (next_h, next_ti, next_ph, next_ix, next_tx) = (
              SELECT h, ti, ph, ix, tx FROM (
                SELECT * FROM (SELECT at_h AS h, at_ti AS ti, at_ph AS ph, at_ix AS ix, at_tx AS tx FROM drep_group_queue
                  WHERE subject = ? AND applied = 0 AND (at_h, at_ti, at_ph, at_ix) > (?, ?, ?, ?)
                  ORDER BY at_h, at_ti, at_ph, at_ix LIMIT 1)
                UNION ALL
                SELECT * FROM (SELECT block_height AS h, tx_index AS ti, 0 AS ph, cert_index AS ix, tx_hash AS tx
                  FROM drep_group_ledger WHERE cred = ? AND (block_height, tx_index, cert_index) > (?, ?, ?)
                  ORDER BY block_height, tx_index, cert_index LIMIT 1))
              ORDER BY h, ti, ph, ix LIMIT 1)
          WHERE cred = ?`,
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
  ...(Object.fromEntries(
    (Object.keys(COMMIT) as Array<keyof typeof COMMIT>).map((k) => [
      k,
      Array.from({ length: COMMIT_WIDTH[k] + (COMMIT_TRAILING[k] ?? 0) }, () => 0),
    ]),
  ) as Record<keyof typeof COMMIT, unknown[]>),
  labelTxPage: [1, 0, 2, 10],
  labelTxProbe: [1, 0, 2],
  readyTracked: [1, 1, 0, 2, 0, 10],
  queueInputs: ['key:00', 1, 0, 2, 0, 2, 0, 2, 0, 10],
  ledgerInputs: ['key:00', 1, 0, 0, 2, 0, 0, 10],
  groupCursor: [1, 0, 2, 0, 'tx', 1, 0, 2, 0],
  credentialCursor: [1, 0, 2, 0, 'tx', 'key:00', 1, 0, 2, 0, 'key:00', 1, 0, 0, 'key:00'],
  frontiers: [],
  pendingRecovery: [],
});
