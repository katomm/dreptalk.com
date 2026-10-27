/// <reference types="@cloudflare/workers-types" />
// Every SQL text the DRep groups store, jobs and page readers run, by name, so one check
// can inspect how SQLite executes each of them.
import { DB_NOW_MS } from '../../db/sql.js';
import { credKeySql, refKeySql } from '../codec.js';
import { LEASE_MS, LISTED_MIN_MEMBERS, WITNESS_BACKOFF_BASE_MS, WITNESS_BACKOFF_MAX_MS } from '../constants.js';

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

// The first checked ledger row with a witness of the tracked row being updated.
const FIRST_WITNESS = `(SELECT l.block_height, l.tx_index, 0, l.cert_index, l.tx_hash FROM drep_group_ledger l
    WHERE l.cred = drep_group_tracked.cred AND l.witness_state = 'checked' AND l.witness IS NOT NULL
    ORDER BY l.block_height, l.tx_index, l.cert_index LIMIT 1)`;

// Ingest statements over a VALUES list of rows, built per chunk length. Binds after the rows are
// listed in INGEST_TRAILING.
export const INGEST = Object.freeze({
  existingTxs: (n: number) => `WITH k(tx) AS (VALUES ${values(1, n)})
    SELECT t.tx_hash, t.marker, t.refetch FROM k JOIN drep_group_txs t ON t.tx_hash = k.tx`,
  // A new tx is inserted, a re-delivered marker flagged for refetch is judged again (its flag is
  // cleared, a tx that is no longer a marker gets its payload columns), anything else stays.
  upsertTxs: (n: number) => `INSERT INTO drep_group_txs (tx_hash, block_height, block_hash, tx_index, marker, payload,
      required_signers, witness_key_hashes, invalid_before, invalid_hereafter, is_valid, payload_repeated, bytes)
    VALUES ${values(13, n)}
    ON CONFLICT (tx_hash) DO UPDATE SET marker = excluded.marker, refetch = 0, payload = excluded.payload,
      required_signers = excluded.required_signers, witness_key_hashes = excluded.witness_key_hashes,
      invalid_before = excluded.invalid_before, invalid_hereafter = excluded.invalid_hereafter,
      is_valid = excluded.is_valid, payload_repeated = excluded.payload_repeated, bytes = excluded.bytes
    WHERE drep_group_txs.marker = 1 AND drep_group_txs.refetch = 1`,
  // The seq is above every tracked row: the maximum is read once per statement, the ordinal keeps rows apart.
  trackCreds: (n: number) => `WITH k(cred, drep, n) AS (VALUES ${values(3, n)})
    INSERT OR IGNORE INTO drep_group_tracked (cred, seq, drep_id, known)
    SELECT k.cred, (SELECT COALESCE(MAX(seq), 0) FROM drep_group_tracked) + k.n, k.drep, NULL FROM k`,
  existingLedger: (n: number) => `WITH k(tx, ix) AS (VALUES ${values(2, n)})
    SELECT l.tx_hash, l.cert_index FROM k JOIN drep_group_ledger l ON l.tx_hash = k.tx AND l.cert_index = k.ix`,
  trackedState: (n: number) => `WITH k(cred) AS (VALUES ${values(1, n)})
    SELECT t.cred, t.known, t.applied_h, t.applied_ti, t.applied_ph, t.applied_ix, t.applied_tx,
      t.found_h, t.found_ti, t.found_ph, t.found_ix, t.found_tx
    FROM k JOIN drep_group_tracked t ON t.cred = k.cred`,
  insertLedger: (n: number) => `INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, drep_id, kind, block_height,
      block_hash, tx_index, block_time, witness, witness_state) VALUES ${values(11, n)}
    ON CONFLICT (tx_hash, cert_index) DO NOTHING`,
  // The unary plus keeps the flag index out, so the update seeks the key list on the primary key.
  knownFromLedger: (n: number) => `WITH k(cred) AS (VALUES ${values(1, n)})
    UPDATE drep_group_tracked SET known = 1, history_done = 0 WHERE cred IN (SELECT cred FROM k) AND +known = 0`,
  // Moves found back to an earlier checked row with a witness. One row per credential.
  moveFound: (n: number) => `WITH d(cred, h, ti, ph, ix, tx) AS (VALUES ${values(6, n)})
    UPDATE drep_group_tracked SET found_h = d.h, found_ti = d.ti, found_ph = d.ph, found_ix = d.ix, found_tx = d.tx
    FROM d WHERE drep_group_tracked.cred = d.cred
      AND (found_h IS NULL OR (found_h, found_ti, found_ph, found_ix) > (d.h, d.ti, d.ph, d.ix))`,
  // Binds the rows, then the known value. A credential is judged once, a later answer changes nothing.
  // The unary plus keeps the flag index out, as in knownFromLedger.
  setKnown: (n: number) => `WITH k(cred) AS (VALUES ${values(1, n)})
    UPDATE drep_group_tracked SET known = ? WHERE cred IN (SELECT cred FROM k) AND +known IS NULL`,
  historyDone: (n: number) => `WITH k(cred) AS (VALUES ${values(1, n)})
    UPDATE drep_group_tracked SET history_done = 1, history_offset = 0 WHERE cred IN (SELECT cred FROM k)`,
  markSolo: (n: number) => `WITH k(cred) AS (VALUES ${values(1, n)})
    UPDATE drep_group_tracked SET solo = 1 WHERE cred IN (SELECT cred FROM k)`,
  witnessChecked: (n: number) => `WITH k(tx, ix, w) AS (VALUES ${values(3, n)})
    UPDATE drep_group_ledger SET witness_state = 'checked', witness = k.w
    FROM k WHERE drep_group_ledger.tx_hash = k.tx AND drep_group_ledger.cert_index = k.ix
      AND drep_group_ledger.witness_state = 'pending'`,
  // found is derived again from the checked rows of every credential named by the rows.
  witnessFound: (n: number) => `WITH k(tx, ix) AS (VALUES ${values(2, n)})
    UPDATE drep_group_tracked SET (found_h, found_ti, found_ph, found_ix, found_tx) = ${FIRST_WITNESS}
    WHERE cred IN (SELECT l.cred FROM k JOIN drep_group_ledger l ON l.tx_hash = k.tx AND l.cert_index = k.ix)`,
  // Binds the rows, then now. The row stays pending, the next try waits base * 2^attempts, capped.
  witnessFailed: (n: number) => `WITH k(tx, ix) AS (VALUES ${values(2, n)})
    UPDATE drep_group_ledger SET witness_attempts = witness_attempts + 1,
      witness_retry_at = ? + MIN(${WITNESS_BACKOFF_BASE_MS} * (1 << MIN(witness_attempts, 30)), ${WITNESS_BACKOFF_MAX_MS})
    FROM k WHERE drep_group_ledger.tx_hash = k.tx AND drep_group_ledger.cert_index = k.ix
      AND drep_group_ledger.witness_state = 'pending'`,
});

export const INGEST_WIDTH: Readonly<Record<keyof typeof INGEST, number>> = Object.freeze({
  existingTxs: 1,
  upsertTxs: 13,
  trackCreds: 3,
  existingLedger: 2,
  trackedState: 1,
  insertLedger: 11,
  knownFromLedger: 1,
  moveFound: 6,
  setKnown: 1,
  historyDone: 1,
  markSolo: 1,
  witnessChecked: 3,
  witnessFound: 2,
  witnessFailed: 2,
});

export const INGEST_TRAILING: Readonly<Partial<Record<keyof typeof INGEST, number>>> = Object.freeze({
  setKnown: 1,
  witnessFailed: 1,
});

// Recovery phases. Every page selects its rows with an indexed predicate that a processed row no
// longer matches, so only the phase name is kept between calls.
export type RecoveryMode = 'truncate' | 'rebuild' | 'fork';

export interface PagedPart {
  name: string;
  /** FROM clause of the page and the probe. */
  from: string;
  /** Holds one ? for the cut height when `cut` is true. */
  where: string;
  cut: boolean;
  order: string;
  key: string;
  /**
   * Statements of one page, each containing the page `pages` times (once by default). `lead` counts the
   * cut height binds before the first page.
   */
  stmts: Array<{ sql: (page: string) => string; lead?: number; pages?: number }>;
  /** The index the page walks in order when its predicate is not a range. */
  boundedScan?: string;
}

const pageSql = (p: PagedPart): string => `SELECT ${p.key} FROM ${p.from} WHERE ${p.where} ORDER BY ${p.order} LIMIT ?`;
const probeSql = (p: PagedPart): string => `SELECT 1 AS hit FROM ${p.from} WHERE ${p.where} ORDER BY ${p.order} LIMIT 1`;

const del = (table: string) => (page: string) => `DELETE FROM ${table} WHERE rowid IN (${page})`;
const above = (name: string, table: string, col: string, stmts?: PagedPart['stmts']): PagedPart => ({
  name,
  from: table,
  where: `${col} > ?`,
  cut: true,
  // rowid makes the order total, so every statement of a batch selects the same page.
  order: `${col}, rowid`,
  key: 'rowid',
  stmts: stmts ?? [{ sql: del(table) }],
});
// A recompute job and a gen increment for the groups of a page, before the page is changed.
const groupTouch = (table: string): PagedPart['stmts'] => [
  {
    sql: (page) => `INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, group_tx, group_ix)
      SELECT 'recompute', ${refKeySql('x.group_tx', 'x.group_ix')}, x.group_tx, x.group_ix FROM ${table} x WHERE x.rowid IN (${page})`,
  },
  {
    sql: (page) => `UPDATE drep_groups SET gen = gen + 1 WHERE (group_tx, group_ix) IN (
      SELECT x.group_tx, x.group_ix FROM ${table} x WHERE x.rowid IN (${page}))`,
  },
];
const nullPos = (p: string): string => `${p}_h = NULL, ${p}_ti = NULL, ${p}_ph = NULL, ${p}_ix = NULL, ${p}_tx = NULL`;
// The first unapplied input of the tracked row strictly after the bound, queue and ledger merged.
// Each side's first row is found on its own index by rowid and the earlier of the two is kept, so
// nothing is sorted. Every bound appears four times, each time in the same order h, ti, ph, ix.
const NEXT_AFTER = (h: string, ti: string, ph: string, ix: string, queueExtra = ''): string => {
  const queueFirst = `(SELECT rowid FROM drep_group_queue
      WHERE subject = drep_group_tracked.cred AND applied = 0 AND (at_h, at_ti, at_ph, at_ix) > (${h}, ${ti}, ${ph}, ${ix})${queueExtra}
      ORDER BY at_h, at_ti, at_ph, at_ix LIMIT 1)`;
  const ledgerFirst = `(SELECT rowid FROM drep_group_ledger
      WHERE cred = drep_group_tracked.cred
        AND (block_height, tx_index, cert_index) > (${h}, ${ti}, CASE WHEN ${ph} = 0 THEN ${ix} ELSE ${MAX} END)
      ORDER BY block_height, tx_index, cert_index LIMIT 1)`;
  return `(next_h, next_ti, next_ph, next_ix, next_tx) = (
    SELECT nq.at_h, nq.at_ti, nq.at_ph, nq.at_ix, nq.at_tx FROM drep_group_queue nq WHERE nq.rowid = ${queueFirst}
      AND NOT EXISTS (SELECT 1 FROM drep_group_ledger nl WHERE nl.rowid = ${ledgerFirst}
        AND (nl.block_height, nl.tx_index, 0, nl.cert_index) < (nq.at_h, nq.at_ti, nq.at_ph, nq.at_ix))
    UNION ALL
    SELECT nl.block_height, nl.tx_index, 0, nl.cert_index, nl.tx_hash FROM drep_group_ledger nl WHERE nl.rowid = ${ledgerFirst}
      AND NOT EXISTS (SELECT 1 FROM drep_group_queue nq WHERE nq.rowid = ${queueFirst}
        AND (nq.at_h, nq.at_ti, nq.at_ph, nq.at_ix) < (nl.block_height, nl.tx_index, 0, nl.cert_index)))`;
};
const T = 'drep_group_tracked';
const APPLIED_BOUND = [`COALESCE(${T}.applied_h, -1)`, `COALESCE(${T}.applied_ti, ${MAX})`, `COALESCE(${T}.applied_ph, 2)`, `COALESCE(${T}.applied_ix, ${MAX})`] as const;
const APPLIED_UNREG = `FROM drep_group_ledger l WHERE l.cred = ${T}.cred AND l.kind = 'unreg'
    AND (l.block_height, l.tx_index, l.cert_index) <= (${APPLIED_BOUND[0]}, ${APPLIED_BOUND[1]},
      CASE WHEN ${T}.applied_ph = 0 THEN ${T}.applied_ix ELSE ${MAX} END)`;
const JOBS_GROUPS = 'drep_group_jobs j JOIN drep_groups g ON g.group_tx = j.group_tx AND g.group_ix = j.group_ix';
const JOB_KINDS = "'dissolve', 'retire', 'repair', 'recompute', 'trim', 'power', 'power-scan'";

const stateDeletes: PagedPart[] = [
  above('versions', 'drep_group_versions', 'at_h'),
  above('scripts', 'drep_group_scripts', 'at_h'),
  above('memberScripts', 'drep_group_member_scripts', 'at_h'),
];
const tailDeletes: PagedPart[] = [above('queue', 'drep_group_queue', 'at_h'), above('contexts', 'drep_group_tx_context', 'block_height')];
const rawDeletes: PagedPart[] = [above('txs', 'drep_group_txs', 'block_height'), above('ledger', 'drep_group_ledger', 'block_height')];

// A rebuild keeps the tracked rows: each page of deleted queue entries derives next again for its
// subjects, from the inputs the page leaves, so no next points at a deleted entry.
const rebuildQueue = above('queue', 'drep_group_queue', 'at_h', [
  {
    sql: (page) => `UPDATE drep_group_tracked SET gen = gen + 1,
      ${NEXT_AFTER(...APPLIED_BOUND, ` AND rowid NOT IN (${page})`)}
      WHERE cred IN (SELECT q.subject FROM drep_group_queue q WHERE q.rowid IN (${page}))`,
    pages: 3,
  },
  { sql: del('drep_group_queue') },
]);

const resetState = (queue: PagedPart): PagedPart[] => [
  ...stateDeletes,
  above('instances', 'drep_group_instances', 'joined_h'),
  above('verdicts', 'drep_group_verdicts', 'at_h'),
  queue,
  above('contexts', 'drep_group_tx_context', 'block_height'),
  above('groups', 'drep_groups', 'cur_h'),
  {
    name: 'jobs',
    from: 'drep_group_jobs',
    where: `kind IN (${JOB_KINDS})`,
    cut: false,
    order: 'kind, id',
    key: 'id',
    stmts: [{ sql: (page) => `DELETE FROM drep_group_jobs WHERE id IN (${page})` }],
  },
  above('trimDue', 'drep_group_trim_due', 'oldest_h'),
  {
    name: 'due',
    from: 'drep_group_due',
    where: "kind IN ('profile', 'website')",
    cut: false,
    order: 'kind, due_at, rowid',
    key: 'rowid',
    stmts: [{ sql: del('drep_group_due') }],
  },
];

/** The paged parts of each phase, in order. `versions` and `cursors` are run by the recovery step itself. */
export const PHASE_PARTS: Readonly<Record<RecoveryMode, Readonly<Record<string, PagedPart[]>>>> = Object.freeze({
  truncate: {
    jobs: [
      {
        name: 'triggered',
        from: 'drep_group_jobs',
        // The unary plus keeps the kind index out, so the page walks the trigger index in order.
        where: "trigger_h > ? AND +kind IN ('dissolve', 'retire')",
        cut: true,
        order: 'trigger_h, id',
        key: 'id',
        stmts: [{ sql: (page) => `DELETE FROM drep_group_jobs WHERE id IN (${page})` }],
      },
      {
        name: 'started',
        from: 'drep_group_jobs',
        where: 'cursor_json IS NOT NULL',
        cut: false,
        order: 'id',
        key: 'id',
        stmts: [{ sql: (page) => `UPDATE drep_group_jobs SET cursor_json = NULL, staging = NULL, start_gen = NULL WHERE id IN (${page})` }],
        boundedScan: 'drep_group_jobs_running',
      },
    ],
    raw: rawDeletes,
    state: [
      ...stateDeletes,
      above('instances', 'drep_group_instances', 'joined_h', [...groupTouch('drep_group_instances'), { sql: del('drep_group_instances') }]),
      above('verdicts', 'drep_group_verdicts', 'at_h', [...groupTouch('drep_group_verdicts'), { sql: del('drep_group_verdicts') }]),
      ...tailDeletes,
    ],
    undo: [
      above('approved', 'drep_group_instances', 'approved_h', [
        ...groupTouch('drep_group_instances'),
        { sql: (page) => `UPDATE drep_group_instances SET ${nullPos('approved')} WHERE rowid IN (${page})` },
      ]),
      above('closed', 'drep_group_instances', 'closed_h', [
        ...groupTouch('drep_group_instances'),
        { sql: (page) => `UPDATE drep_group_instances SET ${nullPos('closed')}, close_reason = NULL WHERE rowid IN (${page})` },
      ]),
    ],
    credentials: [
      above('applied', T, 'applied_h', [
        {
          sql: (page) => `UPDATE ${T} SET applied_h = ?, applied_ti = ${MAX}, applied_ph = 2, applied_ix = ${MAX}, applied_tx = X'',
            gen = gen + 1, ${NEXT_AFTER('?', String(MAX), '2', String(MAX))} WHERE rowid IN (${page})`,
          lead: 5,
        },
      ]),
      above('next', T, 'next_h', [
        { sql: (page) => `UPDATE ${T} SET gen = gen + 1, ${NEXT_AFTER(...APPLIED_BOUND)} WHERE rowid IN (${page})` },
      ]),
      above('found', T, 'found_h', [
        {
          sql: (page) => `UPDATE ${T} SET gen = gen + 1, (found_h, found_ti, found_ph, found_ix, found_tx) = ${FIRST_WITNESS}
            WHERE rowid IN (${page})`,
        },
      ]),
      above('retired', T, 'retired_at_h', [
        {
          sql: (page) => `INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, cred)
            SELECT 'repair', ${credKeySql('x.cred')}, x.cred FROM ${T} x WHERE x.rowid IN (${page})`,
        },
        {
          sql: (page) => `UPDATE ${T} SET gen = gen + 1,
            (retired_at_h, retired_at_ti, retired_at_ph, retired_at_ix, retired_at_tx) = (
              SELECT l.block_height, l.tx_index, 0, l.cert_index, l.tx_hash ${APPLIED_UNREG}
              ORDER BY l.block_height DESC, l.tx_index DESC, l.cert_index DESC LIMIT 1),
            retiring = EXISTS (SELECT 1 ${APPLIED_UNREG})
            WHERE rowid IN (${page})`,
        },
      ]),
      {
        name: 'solo',
        from: T,
        where: 'solo = 1 AND history_offset > 0',
        cut: false,
        order: 'solo, rowid',
        key: 'rowid',
        stmts: [{ sql: (page) => `UPDATE ${T} SET history_offset = 0, gen = gen + 1 WHERE rowid IN (${page})` }],
        boundedScan: 'drep_group_tracked_solo',
      },
    ],
    flags: [
      {
        name: 'closing',
        from: JOBS_GROUPS,
        where: "j.kind = 'recompute' AND g.closing = 0 AND g.dissolved_h <= ?",
        cut: true,
        order: 'j.id',
        key: 'g.rowid',
        stmts: [{ sql: (page) => `UPDATE drep_groups SET closing = 1, gen = gen + 1 WHERE rowid IN (${page})` }],
      },
      {
        name: 'power',
        from: JOBS_GROUPS,
        where: "j.kind = 'recompute' AND NOT EXISTS (SELECT 1 FROM drep_group_jobs p WHERE p.kind = 'power' AND p.job_key = j.job_key)",
        cut: false,
        order: 'j.id',
        key: 'j.id',
        stmts: [
          {
            sql: (page) => `INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, group_tx, group_ix)
              SELECT 'power', x.job_key, x.group_tx, x.group_ix FROM drep_group_jobs x WHERE x.id IN (${page})`,
          },
        ],
      },
    ],
  },
  // Reset parts bind the cut height -1, which every stored height is above.
  rebuild: {
    state: resetState(rebuildQueue),
    credentials: [
      {
        name: 'applied',
        from: T,
        where: 'applied_h IS NOT NULL',
        cut: false,
        order: 'applied_h, rowid',
        key: 'rowid',
        stmts: [
          {
            sql: (page) => `UPDATE ${T} SET ${nullPos('applied')}, gen = gen + 1,
              ${NEXT_AFTER('-1', String(MAX), '2', String(MAX))} WHERE rowid IN (${page})`,
          },
        ],
      },
    ],
    markers: [
      {
        name: 'markers',
        from: 'drep_group_txs',
        where: 'marker = 1 AND refetch = 0',
        cut: false,
        order: 'block_height, rowid',
        key: 'rowid',
        stmts: [{ sql: (page) => `UPDATE drep_group_txs SET refetch = 1 WHERE rowid IN (${page})` }],
        boundedScan: 'drep_group_txs_marker',
      },
    ],
  },
  fork: {
    state: resetState(tailDeletes[0]),
    raw: rawDeletes,
    credentials: [
      {
        name: 'tracked',
        from: T,
        where: 'true',
        cut: false,
        order: 'known, seq',
        key: 'rowid',
        stmts: [{ sql: del(T) }],
        boundedScan: 'drep_group_tracked_known',
      },
    ],
  },
});


/** Phase order of each recovery kind. */
export const PHASE_ORDER: Readonly<Record<RecoveryMode, readonly string[]>> = Object.freeze({
  truncate: ['jobs', 'raw', 'state', 'undo', 'versions', 'credentials', 'flags', 'cursors'],
  rebuild: ['state', 'credentials', 'markers', 'cursors'],
  fork: ['state', 'raw', 'credentials', 'cursors'],
});

const VERSIONS_PROBE = 'SELECT 1 AS hit FROM drep_groups WHERE cur_h > ? ORDER BY cur_h LIMIT 1';

/** Probes of a phase, in part order, with whether each binds the cut height. */
export function phaseProbes(mode: RecoveryMode, phase: string): Array<{ sql: string; cut: boolean }> {
  if (mode === 'truncate' && phase === 'versions') return [{ sql: VERSIONS_PROBE, cut: true }];
  return (PHASE_PARTS[mode][phase] ?? []).map((p) => ({ sql: probeSql(p), cut: p.cut }));
}

/** Binds the cut height of every probe that takes one, then the phase and the next phase. */
export const phaseAdvance = (mode: RecoveryMode, phase: string): string =>
  `UPDATE drep_group_meta SET rec_phase = CASE WHEN ${phaseProbes(mode, phase)
    .map((p) => `EXISTS (${p.sql})`)
    .join(' OR ')} THEN ? ELSE ? END WHERE id = 1`;

export const partPage = pageSql;
export const partProbe = probeSql;

// Groups of the versions phase, each with its latest version at or below the cut.
const VERSIONS_PAGE = `SELECT g.group_tx AS k_gtx, g.group_ix AS k_gix, g.profile_url AS g_url, g.profile_hash AS g_hash, v.*
  FROM drep_groups g
  LEFT JOIN drep_group_versions v ON v.rowid = (
    SELECT x.rowid FROM drep_group_versions x
    WHERE x.group_tx = g.group_tx AND x.group_ix = g.group_ix AND x.at_h <= ?
    ORDER BY x.at_h DESC, x.at_ti DESC, x.at_ph DESC, x.at_ix DESC LIMIT 1)
  WHERE g.cur_h > ? ORDER BY g.cur_h, g.rowid LIMIT ?`;

const RESTORE_COLS = `cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, admission, profile_url, profile_hash, seq, status,
  ${POS('created')}, ${POS('profile_set')}`;
const dissolvedCut = (c: string): string => `dissolved_${c} = CASE WHEN dissolved_h > ? THEN NULL ELSE dissolved_${c} END`;

// Keyed statements of the versions phase, built per chunk length. D1 binds numbers as REAL, so
// refKeySql casts a bound index before it becomes part of a job key.
export const REC_KEYED = Object.freeze({
  // Binds the rows (group, version order columns), then the cut height six times.
  restoreGroups: (n: number) => `WITH k(gtx, gix, h, ti, ph, ix) AS (VALUES ${values(6, n)})
    UPDATE drep_groups SET (${RESTORE_COLS}) = (
        SELECT v.at_h, v.at_ti, v.at_ph, v.at_ix, v.at_tx, v.mode, v.control, v.admission, v.profile_url, v.profile_hash,
          v.seq, v.status, ${POS('v.created')}, ${POS('v.profile_set')}
        FROM drep_group_versions v WHERE v.group_tx = k.gtx AND v.group_ix = k.gix
          AND v.at_h = k.h AND v.at_ti = k.ti AND v.at_ph = k.ph AND v.at_ix = k.ix),
      ${['h', 'ti', 'ph', 'ix', 'tx'].map(dissolvedCut).join(', ')},
      closing = CASE WHEN dissolved_h > ? THEN 0 ELSE closing END,
      gen = gen + 1
    FROM k WHERE drep_groups.group_tx = k.gtx AND drep_groups.group_ix = k.gix`,
  recomputeJobs: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, group_tx, group_ix)
    SELECT 'recompute', ${refKeySql('k.gtx', 'k.gix')}, k.gtx, k.gix FROM k`,
  deleteTrimDue: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    DELETE FROM drep_group_trim_due WHERE (group_tx, group_ix) IN (SELECT gtx, gix FROM k)`,
  deleteGroups: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    DELETE FROM drep_groups WHERE (group_tx, group_ix) IN (SELECT gtx, gix FROM k)`,
});

export const REC_KEYED_WIDTH: Readonly<Record<keyof typeof REC_KEYED, number>> = Object.freeze({
  restoreGroups: 6,
  recomputeJobs: 2,
  deleteTrimDue: 2,
  deleteGroups: 2,
});

export const REC_KEYED_TRAILING: Readonly<Partial<Record<keyof typeof REC_KEYED, number>>> = Object.freeze({
  restoreGroups: 6,
});

const END_G = `G_h = ?, G_ti = ?, G_ph = ?, G_ix = ?, G_tx = ?`;
const RESET_G = `G_h = -1, G_ti = ${MAX}, G_ph = 2, G_ix = ${MAX}, G_tx = X''`;

// Every paged part's page and probe, and every phase's advance statement, by a stable name.
type RecName = `rec_${RecoveryMode}_${string}`;
function recoveryRegistry(): { q: Record<RecName, RegisteredQuery>; binds: Record<RecName, unknown[]> } {
  const q: Record<RecName, RegisteredQuery> = {};
  const binds: Record<RecName, unknown[]> = {};
  for (const mode of Object.keys(PHASE_PARTS) as RecoveryMode[]) {
    for (const phase of PHASE_ORDER[mode]) {
      if (phase === 'cursors') continue;
      const probes = phaseProbes(mode, phase);
      const bounded = (PHASE_PARTS[mode][phase] ?? []).find((p) => p.boundedScan)?.boundedScan;
      q[`rec_${mode}_${phase}_advance`] = { sql: phaseAdvance(mode, phase), ...(bounded ? { boundedScan: bounded } : {}) };
      binds[`rec_${mode}_${phase}_advance`] = [...probes.flatMap((p) => (p.cut ? [1] : [])), phase, phase];
      for (const p of PHASE_PARTS[mode][phase] ?? []) {
        const name: RecName = `rec_${mode}_${phase}_${p.name}`;
        const scan = p.boundedScan ? { boundedScan: p.boundedScan } : {};
        q[`${name}_probe`] = { sql: probeSql(p), ...scan };
        binds[`${name}_probe`] = p.cut ? [1] : [];
        p.stmts.forEach((s, i) => {
          q[`${name}_${i}`] = { sql: s.sql(pageSql(p)), ...scan };
          binds[`${name}_${i}`] = [
            ...Array.from({ length: s.lead ?? 0 }, () => 1),
            ...Array.from({ length: s.pages ?? 1 }, () => [...(p.cut ? [1] : []), 10]).flat(),
          ];
        });
      }
    }
  }
  return { q, binds };
}
const RECOVERY_REGISTRY = recoveryRegistry();

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
  // Binds the applied position, its order columns four times (the bound of the next input), then
  // the credential.
  credentialCursor: {
    sql: `UPDATE drep_group_tracked SET applied_h = ?, applied_ti = ?, applied_ph = ?, applied_ix = ?, applied_tx = ?,
            gen = gen + 1, ${NEXT_AFTER('?', '?', '?', '?')}
          WHERE cred = ?`,
  },
  frontiers: {
    sql: `SELECT L, R, G_h, G_ti, G_ph, G_ix, G_tx,
            (SELECT MIN(block_height) FROM drep_group_txs WHERE refetch = 1) AS refetch_h
          FROM drep_group_meta WHERE id = 1`,
  },
  pendingRecovery: { sql: 'SELECT rec_first_kind, rec_first_above FROM drep_group_meta WHERE id = 1' },
  metaRow: { sql: 'SELECT * FROM drep_group_meta WHERE id = 1' },
  ...(Object.fromEntries(
    (Object.keys(INGEST) as Array<keyof typeof INGEST>).map((k) => [k, { sql: INGEST[k](1) }]),
  ) as Record<keyof typeof INGEST, RegisteredQuery>),
  setL: { sql: 'UPDATE drep_group_meta SET L = ?, L_hash = ? WHERE id = 1' },
  // Binds R and its block time. Creates the registration cursor once a credential is tracked.
  createRegCursor: {
    sql: `UPDATE drep_group_meta SET R = ?, reg_time = ?, reg_offset = 0
          WHERE id = 1 AND R IS NULL AND (SELECT MAX(seq) FROM drep_group_tracked) IS NOT NULL`,
  },
  // Binds the reader time, the offset and R (NULL keeps R).
  regCursor: { sql: 'UPDATE drep_group_meta SET reg_time = ?, reg_offset = ?, R = COALESCE(?, R) WHERE id = 1' },
  historyOffset: { sql: 'UPDATE drep_group_tracked SET history_offset = ? WHERE cred = ?' },
  // Binds both slots, then whether to set the phase and the phase, then rebuilding (NULL keeps it).
  recoverySlots: {
    sql: `UPDATE drep_group_meta SET rec_first_kind = ?, rec_first_above = ?, rec_first_time = ?,
            rec_then_above = ?, rec_then_time = ?, rec_phase = CASE WHEN ? = 1 THEN ? ELSE rec_phase END,
            rebuilding = COALESCE(?, rebuilding)
          WHERE id = 1`,
  },
  ...RECOVERY_REGISTRY.q,
  recVersionsProbe: { sql: VERSIONS_PROBE },
  recVersionsPage: { sql: VERSIONS_PAGE },
  ...(Object.fromEntries(
    (Object.keys(REC_KEYED) as Array<keyof typeof REC_KEYED>).map((k) => [k, { sql: REC_KEYED[k](1) }]),
  ) as Record<keyof typeof REC_KEYED, RegisteredQuery>),
  // The block time of the highest ledger row at or below the cut, block times grow with height.
  recLedgerTime: {
    sql: 'SELECT block_time FROM drep_group_ledger WHERE block_height <= ? ORDER BY block_height DESC LIMIT 1',
  },
  // Binds G, L, L_hash, R and the reader time.
  recTruncateCursors: {
    sql: `UPDATE drep_group_meta SET ${END_G}, L = ?, L_hash = ?, R = ?, reg_time = ?, reg_offset = 0, rec_phase = 'done'
          WHERE id = 1`,
  },
  recRebuildCursors: { sql: `UPDATE drep_group_meta SET ${RESET_G}, rec_phase = 'done' WHERE id = 1` },
  recForkCursors: {
    sql: `UPDATE drep_group_meta SET ${RESET_G}, L = -1, L_hash = NULL, R = NULL, reg_time = NULL, reg_offset = 0,
            probe_active = 0, probe_below = NULL, rec_phase = 'done'
          WHERE id = 1`,
  },
} satisfies Record<string, RegisteredQuery>);

/** Sample binds per query, placeholders only, for the query plan check. */
// Placeholder values of a stored tx hash and credential.
const TX = new Uint8Array(32);
const CRED = new Uint8Array(29);

export const Q_SAMPLE_BINDS: Readonly<Record<keyof typeof Q, unknown[]>> = Object.freeze({
  leaseSeed: [],
  leaseTake: ['owner', 'token', 'owner'],
  leaseToken: [],
  leaseRelease: ['token'],
  leaseGuard: ['token'],
  leaseGuardEnd: [],
  loadInstances: [TX, 0],
  loadLatestInstances: [TX, 0, CRED],
  loadGroupsAt: [TX, 0, 1, 0, 2, 0],
  loadScriptsAt: [TX, 1, 0, 2, 0],
  loadCredentialsAt: [CRED, 1, 0, 2, 0],
  queuedJoins: [TX, 0],
  txContexts: [TX],
  ...(Object.fromEntries(
    (Object.keys(COMMIT) as Array<keyof typeof COMMIT>).map((k) => [
      k,
      Array.from({ length: COMMIT_WIDTH[k] + (COMMIT_TRAILING[k] ?? 0) }, () => 0),
    ]),
  ) as Record<keyof typeof COMMIT, unknown[]>),
  labelTxPage: [1, 0, 2, 10],
  labelTxProbe: [1, 0, 2],
  readyTracked: [1, 1, 0, 2, 0, 10],
  queueInputs: [CRED, 1, 0, 2, 0, 2, 0, 2, 0, 10],
  ledgerInputs: [CRED, 1, 0, 0, 2, 0, 0, 10],
  groupCursor: [1, 0, 2, 0, TX, 1, 0, 2, 0],
  credentialCursor: [1, 0, 2, 0, TX, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0, 2, 0, CRED],
  frontiers: [],
  pendingRecovery: [],
  metaRow: [],
  ...(Object.fromEntries(
    (Object.keys(INGEST) as Array<keyof typeof INGEST>).map((k) => [
      k,
      Array.from({ length: INGEST_WIDTH[k] + (INGEST_TRAILING[k] ?? 0) }, () => 0),
    ]),
  ) as Record<keyof typeof INGEST, unknown[]>),
  setL: [1, 'hash'],
  createRegCursor: [1, 0],
  regCursor: [0, 0, 1],
  historyOffset: [0, CRED],
  recoverySlots: ['truncate', 1, 0, null, null, 1, 'jobs', null],
  ...RECOVERY_REGISTRY.binds,
  recVersionsProbe: [1],
  recVersionsPage: [1, 1, 10],
  ...(Object.fromEntries(
    (Object.keys(REC_KEYED) as Array<keyof typeof REC_KEYED>).map((k) => [
      k,
      Array.from({ length: REC_KEYED_WIDTH[k] + (REC_KEYED_TRAILING[k] ?? 0) }, () => 0),
    ]),
  ) as Record<keyof typeof REC_KEYED, unknown[]>),
  recLedgerTime: [1],
  recTruncateCursors: [1, 0, 2, 0, TX, 1, null, 1, 0],
  recRebuildCursors: [],
  recForkCursors: [],
});
