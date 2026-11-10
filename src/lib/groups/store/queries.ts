/// <reference types="@cloudflare/workers-types" />
// Every SQL text the DRep groups store, jobs and page readers run, by name, so one check
// can inspect how SQLite executes each of them.
import { RETENTION_FLOOR } from 'drep-groups';
import { DB_NOW_MS } from '../../db/sql.js';
import { credKeySql, MAX, refKeySql } from '../codec.js';
import {
  LEASE_MS,
  LISTED_MIN_MEMBERS,
  MARKER_REFETCH_ATTEMPTS,
  PROFILE_MIN_MEMBERS,
  PENDING_INDICATOR_CAP,
  RETENTION_KEEP_APPLIED,
  RETENTION_KEEP_NOT_APPLIED,
  WITNESS_BACKOFF_BASE_MS,
  WITNESS_BACKOFF_MAX_MS,
} from '../constants.js';
import { GROUP_MEMBER_DREPS_SQL } from './memberDrepsSql.js';

export interface RegisteredQuery {
  sql: string;
  /** The index a keyset read with ORDER BY and LIMIT may scan. */
  boundedScan?: string;
}

// The block time of a verdict's tx: the stored label tx, else the ledger row of a certificate tx.
const VERDICT_TIME = 'COALESCE(t.block_time, (SELECT l.block_time FROM drep_group_ledger l WHERE l.tx_hash = v.tx_hash LIMIT 1))';

const LIVE_LEASE = `id = 1 AND token = ? AND expires_at > ${DB_NOW_MS}`;

/** A VALUES list of `rows` tuples of `width` placeholders. */
export const values = (width: number, rows: number): string =>
  Array.from({ length: rows }, () => `(${Array.from({ length: width }, () => '?').join(', ')})`).join(', ');

/** Member avatars a row of the group list shows. */
const LISTED_FACES = 3;

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
  scriptDisplays: (n: number) => `WITH k(hash) AS (VALUES ${values(1, n)})
    SELECT s.hash, s.display_json FROM k JOIN drep_group_scripts s ON s.hash = k.hash WHERE s.display_json IS NOT NULL`,
  treasuryScripts: (n: number) => `WITH k(hash) AS (VALUES ${values(1, n)})
    SELECT s.hash, s.display_json, s.bytes FROM k JOIN drep_group_scripts s ON s.hash = k.hash`,
  drepNames: (n: number) => `WITH k(id) AS (VALUES ${values(1, n)})
    SELECT d.drep_id, d.name FROM k JOIN dreps d ON d.drep_id = k.id WHERE d.name IS NOT NULL`,
  profileDocs: (n: number) => `WITH k(hash) AS (VALUES ${values(1, n)})
    SELECT d.hash, d.body FROM k JOIN drep_group_profile_docs d ON d.hash = k.hash`,
  // The first LISTED_FACES active members of each group by join position, with their name and avatar. The
  // rows come in rowid order, an outer ORDER BY would sort in a temp b-tree, so the reader orders them.
  listedFaces: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    SELECT k.gtx AS k_gtx, k.gix AS k_gix, i.drep_id, i.joined_h, i.joined_ti, i.joined_ph, i.joined_ix,
      d.name AS drep_name, d.hex AS drep_hex,
      d.image_content_hash AS drep_image
    FROM k
    JOIN drep_group_instances i ON i.rowid IN (
      SELECT x.rowid FROM drep_group_instances x
      WHERE x.group_tx = k.gtx AND x.group_ix = k.gix AND x.counted_as = 'open'
      ORDER BY x.joined_h, x.joined_ti, x.joined_ph, x.joined_ix LIMIT ${LISTED_FACES})
    LEFT JOIN dreps d ON d.drep_id = i.drep_id`,
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
  scriptDisplays: 1,
  treasuryScripts: 1,
  drepNames: 1,
  profileDocs: 1,
  listedFaces: 2,
});

const POS = (p: string): string => `${p}_h, ${p}_ti, ${p}_ph, ${p}_ix, ${p}_tx`;
const VERSION_COLS = `group_tx, group_ix, ${POS('at')}, mode, control, admission, profile_url, profile_hash, resigned_control,
  resigned_admission, seq, status, ${POS('created')}, ${POS('profile_set')}`;
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
  upsertVersions: (n: number) => `INSERT OR REPLACE INTO drep_group_versions (${VERSION_COLS}) VALUES ${values(26, n)}`,
  // The group row from its stored version. A create inserts the counters at 0, a later version
  // writes the version fields only, never a counter and never gen.
  upsertGroups: (n: number) => `WITH k(gtx, gix, h, ti, ph, ix) AS (VALUES ${values(6, n)})
    INSERT INTO drep_groups (group_tx, group_ix, ${POS('cur')}, mode, control, admission, profile_url,
      profile_hash, resigned_control, resigned_admission, seq, status, ${POS('created')}, ${POS('profile_set')},
      ${POS('dissolved')}, closing)
    SELECT v.group_tx, v.group_ix, v.at_h, v.at_ti, v.at_ph, v.at_ix, v.at_tx, v.mode, v.control, v.admission,
      v.profile_url, v.profile_hash, v.resigned_control, v.resigned_admission, v.seq, v.status, ${POS('v.created')}, ${POS('v.profile_set')},
      ${['h', 'ti', 'ph', 'ix', 'tx'].map((c) => `CASE WHEN v.status = 'dissolved' THEN v.at_${c} END`).join(', ')},
      CASE WHEN v.status = 'dissolved' THEN 1 ELSE 0 END
    FROM k JOIN drep_group_versions v ON v.group_tx = k.gtx AND v.group_ix = k.gix
      AND v.at_h = k.h AND v.at_ti = k.ti AND v.at_ph = k.ph AND v.at_ix = k.ix
    WHERE true
    ON CONFLICT (group_tx, group_ix) DO UPDATE SET
      cur_h = excluded.cur_h, cur_ti = excluded.cur_ti, cur_ph = excluded.cur_ph, cur_ix = excluded.cur_ix,
      cur_tx = excluded.cur_tx, mode = excluded.mode, control = excluded.control, admission = excluded.admission,
      profile_url = excluded.profile_url, profile_hash = excluded.profile_hash,
      resigned_control = excluded.resigned_control, resigned_admission = excluded.resigned_admission,
      seq = excluded.seq, status = excluded.status,
      created_h = excluded.created_h, created_ti = excluded.created_ti, created_ph = excluded.created_ph,
      created_ix = excluded.created_ix, created_tx = excluded.created_tx,
      profile_set_h = excluded.profile_set_h, profile_set_ti = excluded.profile_set_ti,
      profile_set_ph = excluded.profile_set_ph, profile_set_ix = excluded.profile_set_ix,
      profile_set_tx = excluded.profile_set_tx,
      ${['h', 'ti', 'ph', 'ix', 'tx'].map((c) => `dissolved_${c} = ${dissolvedCase(c)}`).join(', ')},
      closing = CASE WHEN excluded.status = 'dissolved' THEN 1 ELSE closing END
    WHERE (excluded.cur_h, excluded.cur_ti, excluded.cur_ph, excluded.cur_ix)
      >= (drep_groups.cur_h, drep_groups.cur_ti, drep_groups.cur_ph, drep_groups.cur_ix)`,
  // Binds the rows, then now. The profile of a group with a member is due at once.
  dueProfileIfListed: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at)
    SELECT 'profile', g.group_tx, g.group_ix, ? FROM k JOIN drep_groups g ON ${GROUP_KEY}
    WHERE g.members >= ${PROFILE_MIN_MEMBERS}
    ON CONFLICT (kind, group_tx, group_ix) DO UPDATE SET due_at = excluded.due_at`,
  // Binds the rows, then now and the gen guard. A group with an anchor that gets its first member.
  dueProfileIfAnchored: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at)
    SELECT 'profile', g.group_tx, g.group_ix, ? FROM k JOIN drep_groups g ON ${GROUP_KEY}
    WHERE g.profile_url IS NOT NULL AND ${GEN_OK('g')}
    ON CONFLICT (kind, group_tx, group_ix) DO UPDATE SET due_at = excluded.due_at`,
  // Binds the rows, then the gen guard.
  deleteProfileDue: deleteDue("'profile'"),
  deleteWebsiteDue: deleteDue("'website'"),
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
  // Verdicts of the transactions DRepTalk tracks for signing (hex text, as the signing table keeps them).
  // A retried verdict replaces the stored one.
  insertOwnOutcomes: (n: number) => `WITH k(tx, ix, valid, reason, h, now) AS (VALUES ${values(6, n)})
    INSERT INTO drep_group_own_outcomes (tx_hash, idx, valid, reason, at_h, written_at)
    SELECT k.tx, k.ix, k.valid, k.reason, k.h, k.now FROM k
    WHERE EXISTS (SELECT 1 FROM pending_multisig_tx p WHERE p.body_hash = k.tx)
    ON CONFLICT (tx_hash, idx) DO UPDATE SET valid = excluded.valid, reason = excluded.reason`,
  insertPolicyKeys: (n: number) => `INSERT OR IGNORE INTO drep_group_policy_keys (key, script) VALUES ${values(2, n)}`,
  // Binds the hex hashes of applied profile anchors. A hosted document stays anchored for good.
  markProfileDocsAnchored: (n: number) => `WITH k(h) AS (VALUES ${values(1, n)})
    UPDATE drep_group_profile_docs SET anchored = 1 WHERE hash IN (SELECT h FROM k)`,
  insertJoinNotify: (n: number) =>
    `INSERT OR IGNORE INTO drep_group_join_notify (join_tx, join_ix, join_h) VALUES ${values(3, n)}`,
});

/** Bound parameters per row of each commit statement. */
export const COMMIT_WIDTH: Readonly<Record<keyof typeof COMMIT, number>> = Object.freeze({
  preGroups: 2,
  preFirstUnreg: 11,
  preVerdicts: 2,
  insertScripts: 8,
  insertMemberScripts: 8,
  upsertVersions: 26,
  upsertGroups: 6,
  dueProfileIfListed: 2,
  dueProfileIfAnchored: 2,
  deleteProfileDue: 2,
  deleteWebsiteDue: 2,
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
  insertOwnOutcomes: 6,
  insertPolicyKeys: 2,
  markProfileDocsAnchored: 1,
  insertJoinNotify: 3,
});

/** Binds that follow the rows of a commit statement. */
export const COMMIT_TRAILING: Readonly<Partial<Record<keyof typeof COMMIT, number>>> = Object.freeze({
  dueProfileIfListed: 1,
  dueProfileIfAnchored: 2,
  deleteProfileDue: 1,
  deleteWebsiteDue: 1,
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
  // A refetched marker comes without a block time and keeps the stored one.
  upsertTxs: (n: number) => `INSERT INTO drep_group_txs (tx_hash, block_height, block_hash, tx_index, marker, payload,
      required_signers, witness_key_hashes, invalid_before, invalid_hereafter, is_valid, payload_repeated, bytes, block_time)
    VALUES ${values(14, n)}
    ON CONFLICT (tx_hash) DO UPDATE SET marker = excluded.marker, refetch = 0, payload = excluded.payload,
      required_signers = excluded.required_signers, witness_key_hashes = excluded.witness_key_hashes,
      invalid_before = excluded.invalid_before, invalid_hereafter = excluded.invalid_hereafter,
      is_valid = excluded.is_valid, payload_repeated = excluded.payload_repeated, bytes = excluded.bytes,
      block_time = COALESCE(excluded.block_time, drep_group_txs.block_time)
    WHERE drep_group_txs.marker = 1 AND drep_group_txs.refetch = 1`,
  // The seq is above every tracked row: the maximum is read once per statement, the ordinal keeps rows apart.
  trackCreds: (n: number) => `WITH k(cred, n) AS (VALUES ${values(2, n)})
    INSERT OR IGNORE INTO drep_group_tracked (cred, seq, known)
    SELECT k.cred, (SELECT COALESCE(MAX(seq), 0) FROM drep_group_tracked) + k.n, NULL FROM k`,
  existingLedger: (n: number) => `WITH k(tx, ix) AS (VALUES ${values(2, n)})
    SELECT l.tx_hash, l.cert_index FROM k JOIN drep_group_ledger l ON l.tx_hash = k.tx AND l.cert_index = k.ix`,
  trackedState: (n: number) => `WITH k(cred) AS (VALUES ${values(1, n)})
    SELECT t.cred, t.known, t.applied_h, t.applied_ti, t.applied_ph, t.applied_ix, t.applied_tx,
      t.found_h, t.found_ti, t.found_ph, t.found_ix, t.found_tx
    FROM k JOIN drep_group_tracked t ON t.cred = k.cred`,
  insertLedger: (n: number) => `INSERT INTO drep_group_ledger (tx_hash, cert_index, cred, kind, block_height,
      block_hash, tx_index, block_time, witness, witness_state) VALUES ${values(10, n)}
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
  // A reference script search that is not done yet: the row stays pending at its next position.
  witnessProgress: (n: number) => `WITH k(tx, ix, p) AS (VALUES ${values(3, n)})
    UPDATE drep_group_ledger SET ref_search_pos = k.p
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
  insertAnchorRefs: (n: number) => `INSERT OR IGNORE INTO drep_group_anchor_refs (hash, tx_hash) VALUES ${values(2, n)}`,
  // A failed refetch of a flagged marker counts an attempt. The last attempt clears the flag and
  // the count, the marker stays. The unary plus keeps the flag index out.
  refetchFailed: (n: number) => `WITH k(tx) AS (VALUES ${values(1, n)})
    UPDATE drep_group_txs SET
      refetch = CASE WHEN refetch_attempts + 1 >= ${MARKER_REFETCH_ATTEMPTS} THEN 0 ELSE 1 END,
      refetch_attempts = CASE WHEN refetch_attempts + 1 >= ${MARKER_REFETCH_ATTEMPTS} THEN 0 ELSE refetch_attempts + 1 END
    WHERE tx_hash IN (SELECT tx FROM k) AND +refetch = 1`,
  // Binds tx and block time pairs. The block time of stored txs that have none yet.
  setTxTimes: (n: number) => `WITH k(tx, t) AS (VALUES ${values(2, n)})
    UPDATE drep_group_txs SET block_time = k.t FROM k WHERE drep_group_txs.tx_hash = k.tx AND drep_group_txs.block_time IS NULL`,
});

export const INGEST_WIDTH: Readonly<Record<keyof typeof INGEST, number>> = Object.freeze({
  existingTxs: 1,
  upsertTxs: 14,
  trackCreds: 2,
  existingLedger: 2,
  trackedState: 1,
  insertLedger: 10,
  knownFromLedger: 1,
  moveFound: 6,
  setKnown: 1,
  historyDone: 1,
  markSolo: 1,
  witnessChecked: 3,
  witnessFound: 2,
  witnessFailed: 2,
  witnessProgress: 3,
  insertAnchorRefs: 2,
  refetchFailed: 1,
  setTxTimes: 2,
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
// The verdicts of tracked transactions and the resolutions the engine derived from them above the cut, and
// the join requests above it. A resolution is reopened by its height, so one without any outcome row is
// reopened too. A row the resolver found never included keeps its resolution, it does not depend on the chain
// state above the cut.
const ownDeletes: PagedPart[] = [
  above('outcomes', 'drep_group_own_outcomes', 'at_h'),
  {
    name: 'resolutions',
    from: 'pending_multisig_tx',
    where: 'resolved_h > ? AND never_included_at IS NULL',
    cut: true,
    order: 'resolved_h, rowid',
    key: 'rowid',
    stmts: [{ sql: (page) => `UPDATE pending_multisig_tx SET resolution = NULL, resolved_at = NULL, resolved_h = NULL WHERE rowid IN (${page})` }],
  },
  above('joinNotify', 'drep_group_join_notify', 'join_h'),
];
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
  ...ownDeletes,
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
      ...ownDeletes,
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

const RESTORE_COLS = `cur_h, cur_ti, cur_ph, cur_ix, cur_tx, mode, control, admission, profile_url, profile_hash,
  resigned_control, resigned_admission, seq, status, ${POS('created')}, ${POS('profile_set')}`;
const dissolvedCut = (c: string): string => `dissolved_${c} = CASE WHEN dissolved_h > ? THEN NULL ELSE dissolved_${c} END`;

// Keyed statements of the versions phase, built per chunk length. D1 binds numbers as REAL, so
// refKeySql casts a bound index before it becomes part of a job key.
export const REC_KEYED = Object.freeze({
  // Binds the rows (group, version order columns), then the cut height six times.
  restoreGroups: (n: number) => `WITH k(gtx, gix, h, ti, ph, ix) AS (VALUES ${values(6, n)})
    UPDATE drep_groups SET (${RESTORE_COLS}) = (
        SELECT v.at_h, v.at_ti, v.at_ph, v.at_ix, v.at_tx, v.mode, v.control, v.admission, v.profile_url, v.profile_hash,
          v.resigned_control, v.resigned_admission, v.seq, v.status, ${POS('v.created')}, ${POS('v.profile_set')}
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

// Background jobs. A pass walks instances or verdicts by position from the cursor bound in four
// binds (exclusive), at most the bound limit per page.
const JOINED = 'joined_h, joined_ti, joined_ph, joined_ix';
const AT = 'at_h, at_ti, at_ph, at_ix';
const KINDS_BY_PRIORITY = ['recompute', 'repair', 'dissolve', 'retire', 'power-scan', 'power'] as const;
const firstOfKind = (kind: string): string => `(SELECT id FROM drep_group_jobs WHERE kind = '${kind}' ORDER BY id LIMIT 1)`;
// A page of instances with what effectiveClose needs: the group's stored dissolve and the first applied
// unreg of the member after the join, cert bounds as in preFirstUnreg. Group fields for the counters.
// `extra` adds select columns and joins of a page reader.
const instancePass = (where: string, extra = { cols: '', joins: '' }): string => `WITH p AS (SELECT * FROM drep_group_instances WHERE ${where}
      AND (${JOINED}) > (?, ?, ?, ?) ORDER BY ${JOINED} LIMIT ?)
    SELECT p.*, g.group_tx AS g_tx, g.members AS g_members,
      g.dissolved_h AS dis_h, g.dissolved_ti AS dis_ti, g.dissolved_ph AS dis_ph, g.dissolved_ix AS dis_ix, g.dissolved_tx AS dis_tx,
      u.block_height AS u_h, u.tx_index AS u_ti, u.cert_index AS u_ix, u.tx_hash AS u_tx${extra.cols}
    FROM p
    LEFT JOIN drep_groups g ON g.group_tx = p.group_tx AND g.group_ix = p.group_ix
    LEFT JOIN drep_group_tracked t ON t.cred = p.cred${extra.joins}
    LEFT JOIN drep_group_ledger u ON u.rowid = (
      SELECT l.rowid FROM drep_group_ledger l
      WHERE l.cred = p.cred AND l.kind = 'unreg'
        AND (l.block_height, l.tx_index, l.cert_index) > (p.joined_h, p.joined_ti, CASE WHEN p.joined_ph = 0 THEN p.joined_ix ELSE ${MAX} END)
        AND (l.block_height, l.tx_index, l.cert_index) <= (t.applied_h, t.applied_ti, CASE WHEN t.applied_ph = 0 THEN t.applied_ix ELSE ${MAX} END)
      ORDER BY l.block_height, l.tx_index, l.cert_index LIMIT 1)`;
// A member page: the instance pass with the DRep's name, slug, voting power, credential and avatar, whether the member is
// retiring, and whether a stored ledger row of the member lies above its applied position.
const MEMBER_EXTRA = {
  cols: `, d.name AS drep_name, d.slug AS drep_slug, d.voting_power AS drep_power, d.hex AS drep_hex, d.image_content_hash AS drep_image,
      t.retiring AS retiring,
      EXISTS (SELECT 1 FROM drep_group_ledger l WHERE l.cred = p.cred AND (l.block_height, l.tx_index, l.cert_index) >
        (COALESCE(t.applied_h, -1), COALESCE(t.applied_ti, ${MAX}), CASE WHEN t.applied_ph = 0 THEN t.applied_ix ELSE ${MAX} END)) AS unapplied`,
  joins: `
    LEFT JOIN dreps d ON d.drep_id = p.drep_id`,
};
// The trimmable verdicts of one validity class: below the floor, beyond the newest `offset`, newest first.
const TRIMMABLE = `SELECT rowid FROM drep_group_verdicts WHERE group_tx = ? AND group_ix = ? AND valid = ? AND at_h < ?
    ORDER BY at_h DESC, at_ti DESC, at_ph DESC, at_ix DESC LIMIT ? OFFSET ?`;
// The height at which a class first has a trimmable verdict: its oldest verdict beyond the kept number, counted
// from the oldest. Once the floor passes it, more than the kept number lie below the floor.
const firstTrimmable = (valid: number, keep: number): string => `(SELECT at_h FROM drep_group_verdicts
    WHERE group_tx = ? AND group_ix = ? AND valid = ${valid} ORDER BY at_h, at_ti, at_ph, at_ix LIMIT 1 OFFSET ${keep})`;
// The guard of a job statement: the job's group or credential still at the generation the page read.
const GROUP_GEN = 'EXISTS (SELECT 1 FROM drep_groups g WHERE g.group_tx = ? AND g.group_ix = ? AND g.gen = ?)';
const CRED_GEN = 'EXISTS (SELECT 1 FROM drep_group_tracked t WHERE t.cred = ? AND t.gen = ?)';

// Job statements over a VALUES list of rows, built per chunk length. Trailing binds in JOB_TRAILING.
export const JOB = Object.freeze({
  // The caches of a page's instances. Binds the rows, then the gen guard of the instance's group (NULL accepts).
  writeCaches: (n: number) => `WITH d(tx, ix, c, h, ti, ph, eix, etx, r) AS (VALUES ${values(9, n)})
    UPDATE drep_group_instances SET counted_as = d.c, eff_h = d.h, eff_ti = d.ti, eff_ph = d.ph, eff_ix = d.eix,
      eff_tx = d.etx, eff_reason = d.r
    FROM d WHERE drep_group_instances.join_tx = d.tx AND drep_group_instances.join_ix = d.ix
      AND EXISTS (SELECT 1 FROM drep_groups g WHERE g.group_tx = drep_group_instances.group_tx
        AND g.group_ix = drep_group_instances.group_ix AND ${GEN_OK('g')})`,
  // Pending and former deltas per group. Binds the rows, then the gen guard.
  counterDeltas: (n: number) => `WITH d(gtx, gix, dp, df) AS (VALUES ${values(4, n)})
    UPDATE drep_groups SET pending = pending + d.dp, former = former + d.df
    FROM d WHERE drep_groups.group_tx = d.gtx AND drep_groups.group_ix = d.gix AND ${GEN_OK('drep_groups')}`,
  // Keyed on (drep_id, group key after which its page starts). Binds the rows, then the limit per DRep.
  scanInstances: (n: number) => `WITH k(drep, gtx, gix) AS (VALUES ${values(3, n)})
    SELECT k.drep AS k_drep, i.group_tx, i.group_ix FROM k
    JOIN drep_group_instances i ON i.rowid IN (
      SELECT x.rowid FROM drep_group_instances x
      WHERE x.drep_id = k.drep AND x.counted_as = 'open' AND (x.group_tx, x.group_ix) > (k.gtx, k.gix)
      ORDER BY x.group_tx, x.group_ix LIMIT ?)`,
  // A power job for every listed group found by a scan page, and the gen increment that restarts a running one. A
  // group that becomes listed gets its power job from the members publication.
  scanPowerJobs: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    INSERT OR IGNORE INTO drep_group_jobs (kind, job_key, group_tx, group_ix)
    SELECT 'power', ${refKeySql('g.group_tx', 'g.group_ix')}, g.group_tx, g.group_ix
    FROM k JOIN drep_groups g ON ${GROUP_KEY} WHERE g.members >= ${LISTED_MIN_MEMBERS}`,
  scanGens: (n: number) => `WITH k(gtx, gix) AS (VALUES ${values(2, n)})
    UPDATE drep_groups SET gen = gen + 1 WHERE (group_tx, group_ix) IN (SELECT gtx, gix FROM k) AND members >= ${LISTED_MIN_MEMBERS}`,
  // Queue rows whose instances are exhausted, each only at the seq its page read.
  scanDone: (n: number) =>
    `DELETE FROM drep_group_power_changes WHERE (drep_id, seq) IN (VALUES ${values(2, n)})`,
});

export const JOB_WIDTH: Readonly<Record<keyof typeof JOB, number>> = Object.freeze({
  writeCaches: 9,
  counterDeltas: 4,
  scanInstances: 3,
  scanPowerJobs: 2,
  scanGens: 2,
  scanDone: 2,
});

export const JOB_TRAILING: Readonly<Partial<Record<keyof typeof JOB, number>>> = Object.freeze({
  writeCaches: 1,
  counterDeltas: 1,
  scanInstances: 1,
});

const JOB_Q = {
  // The oldest job of every kind and the oldest group due for a trim below the floor, with the recovery slot.
  jobPick: {
    sql: `WITH m AS (SELECT rec_first_kind, L FROM drep_group_meta WHERE id = 1),
        t AS (SELECT d.group_tx, d.group_ix FROM drep_group_trim_due d
          WHERE d.oldest_h < (SELECT L FROM m) - ${RETENTION_FLOOR} ORDER BY d.oldest_h LIMIT 1)
      SELECT m.rec_first_kind AS recovery, m.L AS L, (SELECT group_tx FROM t) AS trim_gtx, (SELECT group_ix FROM t) AS trim_gix,
        ${KINDS_BY_PRIORITY.map((k) => `${firstOfKind(k)} AS "${k}"`).join(', ')}
      FROM m`,
  },
  // Binds the job id. The job with the generation of its group or credential, NULL when that is gone.
  jobRow: {
    sql: `SELECT j.*, g.gen AS g_gen, g.members AS g_members, t.gen AS t_gen FROM drep_group_jobs j
      LEFT JOIN drep_groups g ON g.group_tx = j.group_tx AND g.group_ix = j.group_ix
      LEFT JOIN drep_group_tracked t ON t.cred = j.cred
      WHERE j.id = ?`,
  },
  // Binds the group, the cursor and the limit.
  jobGroupPass: { sql: instancePass('group_tx = ? AND group_ix = ?') },
  // Binds the credential, the cursor and the limit.
  jobCredPass: { sql: instancePass('cred = ?') },
  // Binds the group, the validity class, the cursor and the limit.
  jobVerdictPass: {
    sql: `SELECT ${AT} FROM drep_group_verdicts WHERE group_tx = ? AND group_ix = ? AND valid = ? AND (${AT}) > (?, ?, ?, ?)
      ORDER BY ${AT} LIMIT ?`,
  },
  // Binds the group, the cursor and the limit. Open instances by join position.
  jobPowerPass: {
    sql: `SELECT ${JOINED} FROM drep_group_instances WHERE group_tx = ? AND group_ix = ? AND counted_as = 'open'
      AND (${JOINED}) > (?, ?, ?, ?) ORDER BY ${JOINED} LIMIT ?`,
  },
  // Binds the cursor JSON, the staging value, start_gen and the job id.
  jobProgress: { sql: 'UPDATE drep_group_jobs SET cursor_json = ?, staging = ?, start_gen = ? WHERE id = ?' },
  // Binds the job id.
  jobDelete: { sql: 'DELETE FROM drep_group_jobs WHERE id = ?' },
  // Binds the job id, then the group and its gen.
  jobDeleteAtGroupGen: { sql: `DELETE FROM drep_group_jobs WHERE id = ? AND ${GROUP_GEN}` },
  // Binds the job id, then the credential and its gen.
  jobDeleteAtCredGen: { sql: `DELETE FROM drep_group_jobs WHERE id = ? AND ${CRED_GEN}` },
  // Binds the group, the cursor (exclusive), the page's last key (inclusive), the cursor JSON, start_gen and the job id.
  // Adds the page's voting power to staging inside SQL, the sum never passes through a JS number.
  jobPowerSum: {
    sql: `UPDATE drep_group_jobs SET staging = CAST(COALESCE(CAST(staging AS INTEGER), 0) + (
        SELECT COALESCE(SUM(CAST(d.voting_power AS INTEGER)), 0) FROM drep_group_instances i JOIN dreps d ON d.drep_id = i.drep_id
        WHERE i.group_tx = ? AND i.group_ix = ? AND i.counted_as = 'open'
          AND (i.joined_h, i.joined_ti, i.joined_ph, i.joined_ix) > (?, ?, ?, ?)
          AND (i.joined_h, i.joined_ti, i.joined_ph, i.joined_ix) <= (?, ?, ?, ?)) AS TEXT),
      cursor_json = ?, start_gen = ? WHERE id = ?`,
  },
  // Binds the job id, then the group and the gen.
  jobPowerPublish: {
    sql: `UPDATE drep_groups SET member_power = (SELECT CAST(staging AS INTEGER) FROM drep_group_jobs WHERE id = ?)
      WHERE group_tx = ? AND group_ix = ? AND gen = ?`,
  },
  // Binds pending, former, applied and not applied counts, then the group and the gen. The trimmed
  // verdicts stay in the totals, closing follows a remaining dissolve job.
  jobRecomputePublish: {
    sql: `UPDATE drep_groups SET pending = ?, former = ?, applied_events = ? + trimmed_applied,
        not_applied_events = ? + trimmed_not_applied,
        closing = EXISTS (SELECT 1 FROM drep_group_jobs j WHERE j.kind = 'dissolve' AND j.group_tx = drep_groups.group_tx
          AND j.group_ix = drep_groups.group_ix)
      WHERE group_tx = ? AND group_ix = ? AND gen = ?`,
  },
  // Binds the group and the gen.
  jobDissolveDone: { sql: 'UPDATE drep_groups SET closing = 0 WHERE group_tx = ? AND group_ix = ? AND gen = ?' },
  // Binds the credential and the gen.
  jobRetireDone: { sql: 'UPDATE drep_group_tracked SET retiring = 0 WHERE cred = ? AND gen = ?' },
  // Binds the group, the validity class, the floor, the limit and the number kept. The count of a trim page.
  trimCount: { sql: `WITH c AS (${TRIMMABLE}) SELECT COUNT(*) AS n FROM c` },
  // Same binds as trimCount, the limit is the counted number.
  trimDelete: { sql: `DELETE FROM drep_group_verdicts WHERE rowid IN (${TRIMMABLE})` },
  // Binds the trimmed applied and not applied counts, then the group.
  trimGroup: {
    sql: `UPDATE drep_groups SET trimmed_applied = trimmed_applied + ?, trimmed_not_applied = trimmed_not_applied + ?,
        gen = gen + 1 WHERE group_tx = ? AND group_ix = ?`,
  },
  // Binds the group for each class, then the group. A finished group is due again once the floor passes the first
  // height with a trimmable verdict, without one its row goes.
  trimNext: {
    sql: `UPDATE drep_group_trim_due SET oldest_h = MIN(COALESCE(${firstTrimmable(1, RETENTION_KEEP_APPLIED)}, ${MAX}),
        COALESCE(${firstTrimmable(0, RETENTION_KEEP_NOT_APPLIED)}, ${MAX})) WHERE group_tx = ? AND group_ix = ?`,
  },
  // Binds the group, then the group for each class.
  trimDone: {
    sql: `DELETE FROM drep_group_trim_due WHERE group_tx = ? AND group_ix = ?
      AND ${firstTrimmable(1, RETENTION_KEEP_APPLIED)} IS NULL AND ${firstTrimmable(0, RETENTION_KEEP_NOT_APPLIED)} IS NULL`,
  },
  // Binds the limit. The oldest queued DReps.
  powerQueue: {
    sql: 'SELECT drep_id, seq, after_key FROM drep_group_power_changes ORDER BY seq LIMIT ?',
    boundedScan: 'drep_group_power_changes_seq',
  },
  powerQueued: {
    sql: 'SELECT 1 AS hit FROM drep_group_power_changes ORDER BY seq LIMIT 1',
    boundedScan: 'drep_group_power_changes_seq',
  },
  // Binds the keyset, the DRep and the seq its page read.
  powerProgress: { sql: 'UPDATE drep_group_power_changes SET after_key = ? WHERE drep_id = ? AND seq = ?' },
  powerScanEnqueue: { sql: "INSERT OR IGNORE INTO drep_group_jobs (kind, job_key) VALUES ('power-scan', 'power-scan')" },
  powerScanDone: {
    sql: `DELETE FROM drep_group_jobs WHERE kind = 'power-scan' AND job_key = 'power-scan'
      AND NOT EXISTS (SELECT 1 FROM drep_group_power_changes ORDER BY seq LIMIT 1)`,
    boundedScan: 'drep_group_power_changes_seq',
  },
} satisfies Record<string, RegisteredQuery>;

// A stored tx the engine has fully processed: the group cursor is past the tx end and every credential plane event
// of the tx is at or below its subject's applied cursor, both inclusive. An event of a subject without a tracked
// cursor is not processed. Needs the tx row as `t` and the meta row as `m`, `tx` is the stored tx hash.
const processedSql = (tx: string): string => `(t.tx_hash IS NOT NULL
    AND (m.G_h, m.G_ti, m.G_ph, m.G_ix) >= (t.block_height, t.tx_index, 2, ${MAX})
    AND NOT EXISTS (SELECT 1 FROM drep_group_queue q LEFT JOIN drep_group_tracked c ON c.cred = q.subject
      WHERE q.tx_hash = ${tx} AND (c.applied_h IS NULL
        OR (c.applied_h, c.applied_ti, c.applied_ph, c.applied_ix) < (q.at_h, q.at_ti, q.at_ph, q.at_ix))))`;

// Statements of the resolver and the join notification drain over a VALUES list of rows, built per chunk length.
// The signing table and the outcomes keep hex text, the engine tables BLOBs, so a tx is bound in both forms.
export const OWN = Object.freeze({
  // Binds the stored hash and the hex of each tx. Its height, whether it is processed, and its valid outcomes.
  txProgress: (n: number) => `WITH k(tx, hx) AS (VALUES ${values(2, n)})
    SELECT k.hx AS hx, t.block_height AS h, ${processedSql('k.tx')} AS processed,
      (SELECT COUNT(*) FROM drep_group_own_outcomes o WHERE o.tx_hash = k.hx AND o.valid = 1) AS valid
    FROM k LEFT JOIN drep_group_txs t ON t.tx_hash = k.tx LEFT JOIN drep_group_meta m ON m.id = 1`,
  // Binds tx hex. The txs a signing row tracks.
  trackedTxs: (n: number) => `WITH k(hx) AS (VALUES ${values(1, n)})
    SELECT k.hx AS hx FROM k WHERE EXISTS (SELECT 1 FROM pending_multisig_tx p WHERE p.body_hash = k.hx)`,
  // Verdicts the commit does not write, those without a group, at the height of the stored tx. A stored outcome
  // stays as it is.
  insertGrouplessOutcomes: (n: number) => `WITH k(hx, tx, ix, valid, reason, now) AS (VALUES ${values(6, n)})
    INSERT INTO drep_group_own_outcomes (tx_hash, idx, valid, reason, at_h, written_at)
    SELECT k.hx, k.ix, k.valid, k.reason, t.block_height, k.now FROM k JOIN drep_group_txs t ON t.tx_hash = k.tx
    WHERE EXISTS (SELECT 1 FROM pending_multisig_tx p WHERE p.body_hash = k.hx)
    ON CONFLICT (tx_hash, idx) DO NOTHING`,
  // The resolution columns of signing rows. An open row takes any write, a resolved one only a resolution by the
  // engine (a height) over never included.
  resolveRows: (n: number) => `WITH k(id, res, at, h, ni, spent) AS (VALUES ${values(6, n)})
    UPDATE pending_multisig_tx SET resolution = k.res, resolved_at = k.at, resolved_h = k.h, never_included_at = k.ni,
      spent_seen_h = k.spent
    FROM k WHERE pending_multisig_tx.id = k.id
      AND (pending_multisig_tx.resolved_at IS NULL OR (k.h IS NOT NULL AND pending_multisig_tx.never_included_at IS NOT NULL))`,
  // Binds DRep ids. The active accounts of those DReps.
  notifyUsers: (n: number) => `WITH k(drep) AS (VALUES ${values(1, n)})
    SELECT u.id, u.drep_id FROM k JOIN users u ON u.drep_id = k.drep WHERE u.status = 'active'`,
  deleteJoinNotify: (n: number) => `DELETE FROM drep_group_join_notify WHERE (join_tx, join_ix) IN (VALUES ${values(2, n)})`,
});

export const OWN_WIDTH: Readonly<Record<keyof typeof OWN, number>> = Object.freeze({
  txProgress: 2,
  trackedTxs: 1,
  insertGrouplessOutcomes: 6,
  resolveRows: 6,
  notifyUsers: 1,
  deleteJoinNotify: 2,
});

const RESOLVE_COLS = 'id, body_hash, status, event_count, invalid_hereafter, fee_inputs, spent_seen_h, never_included_at';

const END_G = `G_h = ?, G_ti = ?, G_ph = ?, G_ix = ?, G_tx = ?`;
const RESET_G = `G_h = -1, G_ti = ${MAX}, G_ph = 2, G_ix = ${MAX}, G_tx = X''`;

// Every paged part's page and probe, and every phase's advance statement, by a stable name.
type RecName = `rec_${RecoveryMode}_${string}`;
function recoveryRegistry(): Record<RecName, RegisteredQuery> {
  const q: Record<RecName, RegisteredQuery> = {};
  for (const mode of Object.keys(PHASE_PARTS) as RecoveryMode[]) {
    for (const phase of PHASE_ORDER[mode]) {
      if (phase === 'cursors') continue;
      const bounded = (PHASE_PARTS[mode][phase] ?? []).find((p) => p.boundedScan)?.boundedScan;
      q[`rec_${mode}_${phase}_advance`] = { sql: phaseAdvance(mode, phase), ...(bounded ? { boundedScan: bounded } : {}) };
      for (const p of PHASE_PARTS[mode][phase] ?? []) {
        const name: RecName = `rec_${mode}_${phase}_${p.name}`;
        const scan = p.boundedScan ? { boundedScan: p.boundedScan } : {};
        q[`${name}_probe`] = { sql: probeSql(p), ...scan };
        p.stmts.forEach((s, i) => {
          q[`${name}_${i}`] = { sql: s.sql(pageSql(p)), ...scan };
        });
      }
    }
  }
  return q;
}

const STORED_BLOCK_BELOW = (table: string): string =>
  `SELECT block_height, block_hash FROM ${table} WHERE block_height < ? ORDER BY block_height DESC LIMIT 1`;
const LABEL_TX_RANGE = 'marker = 0 AND (block_height, tx_index) >= (?, ?) AND block_height <= ?';
const READY_TRACKED = `SELECT cred, applied_h, applied_ti, applied_ph, applied_ix, applied_tx,
    next_h, next_ti, next_ph, next_ix, next_tx
  FROM drep_group_tracked
  WHERE complete = 1 AND known = ? AND next_h IS NOT NULL AND (next_h, next_ti, next_ph, next_ix) <= (?, ?, ?, ?)
  ORDER BY next_h, next_ti, next_ph, next_ix LIMIT ?`;

// The listing, for the page readers and the website checks. A listed group counts at least LISTED_MIN_MEMBERS
// DReps, each DRep counting only toward its oldest open membership (counted_members, migration 0128). The partial index drep_groups_listed covers
// counted_members >= 1 and orders by member power and then the group key. SQLite uses a partial index only when
// the query names its predicate term as written, so that term stays literal and a higher threshold is a second
// filter. member_power can exceed 2^53, so it is read as TEXT and bound as CAST(? AS INTEGER).
const LISTED = `g.counted_members >= 1${LISTED_MIN_MEMBERS > 1 ? ` AND g.counted_members >= ${LISTED_MIN_MEMBERS}` : ''}`;

// One page of the due queue, stale rows included so that the LIMIT bounds what is read. A profile due row is
// stale when its group is gone, has no member or has no anchor, a website due row when the group is gone or
// not listed (the LISTED term on counted_members) or its profile names no website.
const PROFILE_DUE_PAGE = `SELECT d.rowid AS id, d.group_tx, d.group_ix, g.profile_url, g.profile_hash,
    (g.group_tx IS NULL OR g.profile_url IS NULL OR g.profile_hash IS NULL OR g.members < ${PROFILE_MIN_MEMBERS}) AS stale
  FROM drep_group_due d LEFT JOIN drep_groups g ON g.group_tx = d.group_tx AND g.group_ix = d.group_ix
  WHERE d.kind = 'profile' AND d.due_at <= ? ORDER BY d.due_at, d.rowid LIMIT ?`;
const WEBSITE_DUE_PAGE = `SELECT d.rowid AS id, d.group_tx, d.group_ix, p.website,
    (g.group_tx IS NULL OR NOT (${LISTED}) OR p.website IS NULL) AS stale
  FROM drep_group_due d
  LEFT JOIN drep_groups g ON g.group_tx = d.group_tx AND g.group_ix = d.group_ix
  LEFT JOIN drep_group_profiles p ON p.group_tx = d.group_tx AND p.group_ix = d.group_ix
  WHERE d.kind = 'website' AND d.due_at <= ? ORDER BY d.due_at, d.rowid LIMIT ?`;
// The group still carries the anchor a fetched profile belongs to.
const SAME_ANCHOR = `EXISTS (SELECT 1 FROM drep_groups g WHERE g.group_tx = drep_group_due.group_tx
    AND g.group_ix = drep_group_due.group_ix AND g.profile_url = ? AND g.profile_hash = ?)`;

// Page readers.
const LISTED_ORDER = 'g.member_power DESC, g.group_tx, g.group_ix';
const GROUP_READ = `g.group_tx, g.group_ix, g.mode, g.status, g.seq, g.control, g.admission, g.profile_url, g.profile_hash,
    g.resigned_control, g.resigned_admission, g.created_h, g.profile_set_h, g.members, g.pending, g.former, g.applied_events, g.not_applied_events,
    CAST(g.member_power AS TEXT) AS member_power, g.closing`;
const LISTED_READ = `${GROUP_READ}, p.name AS p_name, p.image AS p_image, p.website_verified_at AS p_verified`;
const PROFILE_JOIN = 'LEFT JOIN drep_group_profiles p ON p.group_tx = g.group_tx AND p.group_ix = g.group_ix';
// A later listed page: the rest of the cursor's power after its group key, then the lower powers. Each part
// reads at most the limit, the reader keeps the first `limit` rows of both in this order.
const LISTED_AFTER = `WITH same AS (SELECT ${LISTED_READ} FROM drep_groups g ${PROFILE_JOIN}
      WHERE ${LISTED} AND g.member_power = CAST(?1 AS INTEGER) AND (g.group_tx, g.group_ix) > (?2, ?3)
      ORDER BY g.group_tx, g.group_ix LIMIT ?4),
    lower AS (SELECT ${LISTED_READ} FROM drep_groups g ${PROFILE_JOIN}
      WHERE ${LISTED} AND g.member_power < CAST(?1 AS INTEGER) ORDER BY ${LISTED_ORDER} LIMIT ?4)
    SELECT 0 AS part, * FROM same UNION ALL SELECT 1 AS part, * FROM lower`;
const PROFILE_READ = `p.group_tx AS p_gtx, p.profile_url AS p_url, p.data_hash AS p_hash, p.status AS p_status, p.name AS p_name,
    p.description AS p_description, p.website AS p_website, p.image AS p_image, p.charter AS p_charter,
    p.payment_addresses_json AS p_payments, p.fetched_at AS p_fetched, p.website_verified_at AS p_verified,
    p.website_checked_at AS p_checked`;

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
  scriptDisplays: { sql: KEYED.scriptDisplays(1) },
  treasuryScripts: { sql: KEYED.treasuryScripts(1) },
  drepNames: { sql: KEYED.drepNames(1) },
  listedFaces: { sql: KEYED.listedFaces(1) },
  // Binds the key hash. The active groups with the key in their control or admission policy, with the
  // roles that list it and the resigned keys of each role.
  groupsForPolicyKey: {
    // One OR over the two policy indexes, so each group comes back once without a sort for a UNION.
    sql: `SELECT g.group_tx, g.group_ix, g.resigned_control, g.resigned_admission,
            g.control IN (SELECT script FROM drep_group_policy_keys WHERE key = ?1) AS in_control,
            coalesce(g.admission IN (SELECT script FROM drep_group_policy_keys WHERE key = ?1), 0) AS in_admission
          FROM drep_groups g
          WHERE (g.control IN (SELECT script FROM drep_group_policy_keys WHERE key = ?1)
             OR g.admission IN (SELECT script FROM drep_group_policy_keys WHERE key = ?1))
            AND g.status = 'active'
          LIMIT 100`,
  },
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
  // Binds the request read. Clears an operator truncation request once it is opened, a newer request stays.
  operatorTruncateClear: { sql: 'UPDATE drep_group_meta SET operator_truncate = NULL WHERE id = 1 AND operator_truncate = ?' },
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
  // Binds the height. The highest stored label tx block below it, and the same for ledger rows.
  probeTxBlock: { sql: STORED_BLOCK_BELOW('drep_group_txs') },
  probeLedgerBlock: { sql: STORED_BLOCK_BELOW('drep_group_ledger') },
  // Binds the flag and the lowest height probed so far (NULL with the flag cleared).
  probeState: { sql: 'UPDATE drep_group_meta SET probe_active = ?, probe_below = CAST(? AS INTEGER) WHERE id = 1' },
  // Binds the limit. Credentials not judged by the gate yet, oldest first.
  gateCandidates: { sql: 'SELECT cred FROM drep_group_tracked WHERE known IS NULL ORDER BY seq LIMIT ?' },
  // Binds solo (0 for the batched read, 1 for paged ones) and the limit. Known credentials whose history is not read yet.
  historyCandidates: {
    sql: 'SELECT cred, history_offset FROM drep_group_tracked WHERE known = 1 AND history_done = 0 AND solo = ? ORDER BY seq LIMIT ?',
  },
  // Binds now and the limit. Pending reg rows whose witness check is due, in the order of the partial index.
  pendingWitnesses: {
    sql: `SELECT tx_hash, cert_index, cred, block_height, tx_index, ref_search_pos, witness_attempts FROM drep_group_ledger
          WHERE witness_state = 'pending' AND witness_retry_at <= ?
          ORDER BY witness_retry_at, block_height, tx_index, cert_index LIMIT ?`,
  },
  // Binds the limit. Markers flagged for refetch by a rebuild, lowest first.
  refetchMarkers: {
    sql: `SELECT tx_hash, block_height, block_hash, tx_index, refetch_attempts FROM drep_group_txs
          WHERE refetch = 1 ORDER BY block_height, tx_index LIMIT ?`,
    boundedScan: 'drep_group_txs_refetch',
  },
  // Binds the limit. Stored txs without a block time, lowest first, for the backfill of rows stored before the column.
  txsWithoutTime: {
    sql: 'SELECT tx_hash FROM drep_group_txs WHERE block_time IS NULL ORDER BY block_height LIMIT ?',
    boundedScan: 'drep_group_txs_no_time',
  },
  // Whether any label tx or ledger row is stored.
  storedInputs: {
    sql: `SELECT (SELECT 1 FROM drep_group_txs WHERE block_height >= 0 LIMIT 1) AS txs,
            (SELECT 1 FROM drep_group_ledger WHERE block_height >= 0 LIMIT 1) AS ledger`,
  },
  libVersion: { sql: 'UPDATE drep_group_meta SET lib_version = ? WHERE id = 1' },
  // Script credential registrations whose witness search found no member script are searched again
  // from the start, if they lie before the credential's found witness or the credential has none.
  // A row after found cannot change it, the first witness wins and every witness of a credential
  // carries the same script. Skipped rows lie after found by construction and stay. Run once by the
  // rebuild of a library version change. A stored credential starts with its kind byte, 1 for a
  // script, so the range seeks the credential index.
  witnessSearchReset: {
    sql: `UPDATE drep_group_ledger SET witness_state = 'pending', witness_attempts = 0, witness_retry_at = 0, ref_search_pos = 0
          WHERE cred >= X'01' AND cred < X'02' AND kind = 'reg' AND witness_state = 'checked' AND witness IS NULL
            AND NOT EXISTS (SELECT 1 FROM drep_group_tracked t WHERE t.cred = drep_group_ledger.cred AND t.found_h IS NOT NULL
              AND (t.found_h, t.found_ti, t.found_ix) < (drep_group_ledger.block_height, drep_group_ledger.tx_index, drep_group_ledger.cert_index))`,
  },
  // Binds both slots, then whether to set the phase and the phase, then rebuilding (NULL keeps it).
  recoverySlots: {
    sql: `UPDATE drep_group_meta SET rec_first_kind = ?, rec_first_above = ?, rec_first_time = ?,
            rec_then_above = ?, rec_then_time = ?, rec_phase = CASE WHEN ? = 1 THEN ? ELSE rec_phase END,
            rebuilding = COALESCE(?, rebuilding)
          WHERE id = 1`,
  },
  ...recoveryRegistry(),
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
  ...JOB_Q,
  ...(Object.fromEntries(
    (Object.keys(JOB) as Array<keyof typeof JOB>).map((k) => [`job_${k}`, { sql: JOB[k](1) }]),
  ) as Record<`job_${keyof typeof JOB}`, RegisteredQuery>),
  ...(Object.fromEntries(
    (Object.keys(OWN) as Array<keyof typeof OWN>).map((k) => [`own_${k}`, { sql: OWN[k](1) }]),
  ) as Record<`own_${keyof typeof OWN}`, RegisteredQuery>),
  // Binds the limit. Open group rows, the oldest expiry first.
  resolveOpen: {
    sql: `SELECT ${RESOLVE_COLS} FROM pending_multisig_tx WHERE subject_kind != 'drep' AND resolved_at IS NULL
          ORDER BY invalid_hereafter LIMIT ?`,
    boundedScan: 'pending_multisig_tx_unresolved',
  },
  // Binds the limit. Rows resolved as never included, the newest first.
  resolveNeverIncluded: {
    sql: `SELECT ${RESOLVE_COLS} FROM pending_multisig_tx WHERE never_included_at IS NOT NULL
          ORDER BY never_included_at DESC LIMIT ?`,
    boundedScan: 'pending_multisig_tx_never_included',
  },
  // Binds the columns of a new group signing row, the control slot flag 17th, the fee payment keys 18th, then the
  // three forms of the subject id (groupIdFormsOf), whatever form the subject is stored in. A control row is stored
  // only while the group has no open control row under any id form, in the same statement.
  actionCreate: {
    sql: `INSERT INTO pending_multisig_tx (id, drep_id, action, action_params, unsigned_tx_cbor, body_hash, native_script,
            witnesses, status, tx_hash, created_by, created_at, expires_at, subject_kind, required_signers, invalid_hereafter,
            fee_inputs, event_count, profile_hash, control_slot, fee_pay_keys)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', 'collecting', NULL, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
          WHERE ?17 = 0 OR NOT EXISTS (
            SELECT 1 FROM pending_multisig_tx WHERE drep_id IN (?19, ?20, ?21) AND control_slot = 1 AND resolved_at IS NULL)`,
  },
  // Binds the cutoff in milliseconds and the limit. Group and member rows resolved before the cutoff, the oldest first.
  actionPruneResolved: {
    sql: `DELETE FROM pending_multisig_tx WHERE rowid IN (
            SELECT rowid FROM pending_multisig_tx WHERE subject_kind != 'drep' AND resolved_at IS NOT NULL AND resolved_at < ?
            ORDER BY resolved_at LIMIT ?)`,
  },
  // Binds the limit. Fee inputs of the open group rows: collecting or submitted, not resolved. A cancelled row is left out.
  actionOpenInputs: {
    sql: `SELECT id, created_by, fee_inputs FROM pending_multisig_tx
          WHERE subject_kind != 'drep' AND resolved_at IS NULL AND status IN ('collecting', 'submitted') AND fee_inputs IS NOT NULL
          ORDER BY invalid_hereafter LIMIT ?`,
    boundedScan: 'pending_multisig_tx_unresolved',
  },
  // Binds the user, then the limit. The same rows, only those the user opened.
  actionOpenInputsOf: {
    sql: `SELECT id, created_by, fee_inputs FROM pending_multisig_tx
          WHERE subject_kind != 'drep' AND resolved_at IS NULL AND status IN ('collecting', 'submitted') AND fee_inputs IS NOT NULL AND created_by = ?
          ORDER BY invalid_hereafter LIMIT ?`,
    boundedScan: 'pending_multisig_tx_unresolved',
  },
  // Binds the three forms of the group id (groupIdFormsOf). The row holding the group's control slot.
  actionOpenControl: {
    sql: 'SELECT * FROM pending_multisig_tx WHERE drep_id IN (?, ?, ?) AND control_slot = 1 AND resolved_at IS NULL LIMIT 1',
  },
  // Binds the row id, now in seconds and now in milliseconds. A collecting or cancelled control row whose seq is
  // stale resolves failed and closes. resolved_at counts milliseconds like the resolver's, cancelled_at seconds.
  actionFreeStale: {
    sql: `UPDATE pending_multisig_tx SET resolution = 'failed', resolved_at = ?3, status = 'cancelled',
            cancelled_at = COALESCE(cancelled_at, ?2)
          WHERE id = ?1 AND control_slot = 1 AND resolved_at IS NULL AND status != 'submitted'`,
  },
  // Binds the row id and now. Cancels a collecting row, its slot stays held.
  actionCancel: {
    sql: `UPDATE pending_multisig_tx SET status = 'cancelled', cancelled_at = ?2 WHERE id = ?1 AND status = 'collecting'`,
  },
  // Binds the group. The name of the group's stored profile.
  actionGroupName: { sql: 'SELECT name FROM drep_group_profiles WHERE group_tx = ? AND group_ix = ?' },
  // Binds the limit. The oldest queued join requests with their instance, group policy, names and whether the join
  // tx is processed.
  joinNotifyPage: {
    sql: `SELECT n.join_tx, n.join_ix, i.join_tx AS i_tx, i.group_tx, i.group_ix, i.approved_h, i.closed_h, i.eff_h,
            s.bytes AS policy, CASE WHEN g.admission IS NULL THEN g.resigned_control ELSE g.resigned_admission END AS resigned,
            p.name AS group_name, d.name AS member_name, ${processedSql('n.join_tx')} AS processed
          FROM drep_group_join_notify n
          LEFT JOIN drep_group_txs t ON t.tx_hash = n.join_tx
          LEFT JOIN drep_group_meta m ON m.id = 1
          LEFT JOIN drep_group_instances i ON i.join_tx = n.join_tx AND i.join_ix = n.join_ix
          LEFT JOIN drep_groups g ON g.group_tx = i.group_tx AND g.group_ix = i.group_ix
          LEFT JOIN drep_group_scripts s ON s.hash = COALESCE(g.admission, g.control)
          LEFT JOIN drep_group_profiles p ON p.group_tx = i.group_tx AND p.group_ix = i.group_ix
          LEFT JOIN dreps d ON d.drep_id = i.drep_id
          ORDER BY n.join_h, n.rowid LIMIT ?`,
    boundedScan: 'drep_group_join_notify_h',
  },
  // Binds now and the limit. The oldest due profile rows with their group's anchor.
  profileDuePage: { sql: PROFILE_DUE_PAGE },
  // Binds now and the limit, the same page as profileDuePage. Drops its stale rows.
  profileDueDropStale: { sql: `WITH page AS (${PROFILE_DUE_PAGE}) DELETE FROM drep_group_due WHERE rowid IN (SELECT id FROM page WHERE stale = 1)` },
  // Binds now and the limit. The oldest due website rows with the website of their profile.
  websiteDuePage: { sql: WEBSITE_DUE_PAGE },
  websiteDueDropStale: { sql: `WITH page AS (${WEBSITE_DUE_PAGE}) DELETE FROM drep_group_due WHERE rowid IN (SELECT id FROM page WHERE stale = 1)` },
  // Binds the group, url, hash, status, the five fields, the payment addresses, then the three times.
  upsertProfile: {
    sql: `INSERT INTO drep_group_profiles (group_tx, group_ix, profile_url, data_hash, status, name, description, website,
            image, charter, payment_addresses_json, fetched_at, website_verified_at, website_checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER))
          ON CONFLICT (group_tx, group_ix) DO UPDATE SET profile_url = excluded.profile_url, data_hash = excluded.data_hash,
            status = excluded.status, name = excluded.name, description = excluded.description, website = excluded.website,
            image = excluded.image, charter = excluded.charter, payment_addresses_json = excluded.payment_addresses_json,
            fetched_at = excluded.fetched_at, website_verified_at = excluded.website_verified_at,
            website_checked_at = excluded.website_checked_at`,
  },
  // Binds the group and the hash of the document.
  profileStored: { sql: 'SELECT 1 AS hit FROM drep_group_profiles WHERE group_tx = ? AND group_ix = ? AND data_hash = ?' },
  // Binds the group, then the anchor the profile was fetched for.
  profileDueDone: {
    sql: `DELETE FROM drep_group_due WHERE kind = 'profile' AND group_tx = ? AND group_ix = ? AND ${SAME_ANCHOR}`,
  },
  // Binds the new due time, the group, then the anchor.
  profileDueRetry: {
    sql: `UPDATE drep_group_due SET due_at = CAST(? AS INTEGER)
          WHERE kind = 'profile' AND group_tx = ? AND group_ix = ? AND ${SAME_ANCHOR}`,
  },
  // Binds the due time, the group, the anchor. A listed group whose anchor is still the fetched one.
  websiteDueUpsert: {
    sql: `INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at)
          SELECT 'website', g.group_tx, g.group_ix, CAST(? AS INTEGER) FROM drep_groups g
          WHERE g.group_tx = ? AND g.group_ix = ? AND g.profile_url = ? AND g.profile_hash = ?
            AND ${LISTED}
          ON CONFLICT (kind, group_tx, group_ix) DO UPDATE SET due_at = excluded.due_at`,
  },
  // Binds the check time, whether it verified (0 or 1), the check time, then the group.
  websiteCheck: {
    sql: `UPDATE drep_group_profiles SET website_checked_at = CAST(? AS INTEGER),
            website_verified_at = CASE WHEN ? = 1 THEN CAST(? AS INTEGER) ELSE NULL END
          WHERE group_tx = ? AND group_ix = ?`,
  },
  // Binds the next due time, then the group.
  websiteDueMove: {
    sql: "UPDATE drep_group_due SET due_at = CAST(? AS INTEGER) WHERE kind = 'website' AND group_tx = ? AND group_ix = ?",
  },
  // Binds the limit. The first page of the listed groups.
  listedFirst: {
    sql: `SELECT ${LISTED_READ} FROM drep_groups g ${PROFILE_JOIN} WHERE ${LISTED} ORDER BY ${LISTED_ORDER} LIMIT ?`,
    boundedScan: 'drep_groups_listed',
  },
  // Binds the cursor's power, its group key and the limit.
  listedAfter: { sql: LISTED_AFTER },
  // The member power of the first listed group.
  listedTopPower: {
    sql: `SELECT CAST(g.member_power AS TEXT) AS member_power FROM drep_groups g WHERE ${LISTED} ORDER BY ${LISTED_ORDER} LIMIT 1`,
    boundedScan: 'drep_groups_listed',
  },
  // Binds the limit. Listed active groups by member power.
  sitemapGroups: {
    sql: `SELECT g.group_tx, g.group_ix FROM drep_groups g WHERE ${LISTED} AND g.status = 'active' ORDER BY ${LISTED_ORDER} LIMIT ?`,
    boundedScan: 'drep_groups_listed',
  },
  // Binds the group. The group with its stored profile and the block time of its founding tx.
  groupRow: {
    sql: `SELECT ${GROUP_READ}, ${PROFILE_READ}, (SELECT t.block_time FROM drep_group_txs t WHERE t.tx_hash = g.group_tx) AS created_time FROM drep_groups g ${PROFILE_JOIN} WHERE g.group_tx = ? AND g.group_ix = ?`,
  },
  // Binds the group, counted_as, the cursor and the limit. One member list by join position.
  memberPage: { sql: instancePass('group_tx = ? AND group_ix = ? AND counted_as = ?', MEMBER_EXTRA) },
  // Binds the group, the cursor and the limit. All instances of a closing group by join position.
  closingMemberPage: { sql: instancePass('group_tx = ? AND group_ix = ?', MEMBER_EXTRA) },
  // Binds the group, the validity class and the limit. Newest first.
  verdictPage: {
    sql: `SELECT v.tx_hash, v.idx, v.tag, v.valid, v.reason, v.at_h, ${VERDICT_TIME} AS block_time
          FROM drep_group_verdicts v LEFT JOIN drep_group_txs t ON t.tx_hash = v.tx_hash
          WHERE v.group_tx = ? AND v.group_ix = ? AND v.valid = ?
          ORDER BY v.at_h DESC, v.at_ti DESC, v.at_ph DESC, v.at_ix DESC LIMIT ?`,
  },
  // The newest applied verdicts of a group with their subject, for the history.
  historyVerdicts: {
    sql: `SELECT v.tx_hash, v.idx, v.tag, v.subject, v.at_h, v.at_ti, v.at_ph, v.at_ix, ${VERDICT_TIME} AS block_time
          FROM drep_group_verdicts v LEFT JOIN drep_group_txs t ON t.tx_hash = v.tx_hash
          WHERE v.group_tx = ? AND v.group_ix = ? AND v.valid = 1
          ORDER BY v.at_h DESC, v.at_ti DESC, v.at_ph DESC, v.at_ix DESC LIMIT ?`,
  },
  // The newest versions of a group, the policies and profile each change set.
  historyVersions: {
    sql: `SELECT at_tx, control, admission, profile_hash, resigned_control, resigned_admission FROM drep_group_versions
          WHERE group_tx = ? AND group_ix = ? ORDER BY at_h DESC, at_ti DESC, at_ph DESC, at_ix DESC LIMIT ?`,
  },
  // Binds the group. The stored profile of the group while it has a verified one.
  profileCurrent: {
    sql: "SELECT lower(hex(data_hash)) AS hash, name, description, website, charter, image FROM drep_group_profiles WHERE group_tx = ? AND group_ix = ? AND status = 'ok'",
  },
  // Binds the group, then the anchor to skip. The latest earlier profile anchor of the group with its hosted document, if any.
  profileEarlier: {
    sql: `SELECT d.body AS body FROM drep_group_versions v LEFT JOIN drep_group_profile_docs d ON d.hash = lower(hex(v.profile_hash))
          WHERE v.group_tx = ? AND v.group_ix = ? AND v.profile_hash IS NOT NULL AND v.profile_hash != ?
          ORDER BY v.at_h DESC, v.at_ti DESC, v.at_ph DESC, v.at_ix DESC LIMIT 1`,
  },
  // Binds the anchor hash. The hosted profile document.
  profileDocBody: { sql: 'SELECT body FROM drep_group_profile_docs WHERE hash = ?' },
  // Binds the group twice. Whether it is closing and its queued membership events, at most the cap.
  pendingVerification: {
    sql: `WITH q AS (SELECT 1 FROM drep_group_queue WHERE group_tx = ?1 AND group_ix = ?2 AND applied = 0 LIMIT ${PENDING_INDICATOR_CAP})
          SELECT (SELECT closing FROM drep_groups WHERE group_tx = ?1 AND group_ix = ?2) AS closing, (SELECT COUNT(*) FROM q) AS queued`,
  },
  // Binds the DRep and the limit. Active groups the DRep is an open member of, by group key.
  drepGroups: {
    sql: `SELECT i.group_tx, i.group_ix, g.mode, p.name, p.image FROM drep_group_instances i
          JOIN drep_groups g ON g.group_tx = i.group_tx AND g.group_ix = i.group_ix AND g.status = 'active' ${PROFILE_JOIN}
          WHERE i.drep_id = ? AND i.counted_as = 'open' ORDER BY i.group_tx, i.group_ix LIMIT ?`,
  },
  // Binds the DRep id and the limit. Active groups the DRep is a member of or has an open request in.
  drepMemberships: {
    sql: `SELECT i.group_tx, i.group_ix FROM drep_group_instances i
          JOIN drep_groups g ON g.group_tx = i.group_tx AND g.group_ix = i.group_ix AND g.status = 'active'
          WHERE i.drep_id = ? AND i.counted_as IN ('open', 'pending') LIMIT ?`,
  },
  groupMemberDreps: { sql: GROUP_MEMBER_DREPS_SQL },
  recForkCursors: {
    sql: `UPDATE drep_group_meta SET ${RESET_G}, L = -1, L_hash = NULL, R = NULL, reg_time = NULL, reg_offset = 0,
            probe_active = 0, probe_below = NULL, rec_phase = 'done'
          WHERE id = 1`,
  },
} satisfies Record<string, RegisteredQuery>);
