// Read and write the constitutional committee membership timeline (the
// committee_member / committee_hot_key tables). getCommitteeTimeline loads the
// full timeline for the yes-percentage recompute; the upserts are used by the
// live Koios sync and the one-time historical seed. Distinct from
// koios/committee.ts, which is pure math on a single live committee_info snapshot.
import type { CommitteeMember } from '../koios/client.js';
import { committeeBoundaryForAction, type CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import { epochStartUnix, type NetworkConfig } from '../config/network.js';
import { ccTallyPct, type CcVote } from '../koios/corrections.js';
import { concludedStatusSql } from './sql.js';

interface MemberRow {
  cold_key_hex: string;
  version_from: number;
  version_to: number | null;
  term_expiration: number;
  authorized_from: number;
  resigned_at: number | null;
}

/** Loads every committee member (all versions) and the hot-key to cold-key map. */
export async function getCommitteeTimeline(
  db: D1Database,
): Promise<{ members: CommitteeMemberTerm[]; hotToCold: Map<string, string> }> {
  const [memberRes, hotRes] = await Promise.all([
    db
      .prepare(
        'SELECT cold_key_hex, version_from, version_to, term_expiration, authorized_from, resigned_at FROM committee_member',
      )
      .all<MemberRow>(),
    db.prepare('SELECT hot_key_hex, cold_key_hex FROM committee_hot_key').all<{ hot_key_hex: string; cold_key_hex: string }>(),
  ]);

  const members: CommitteeMemberTerm[] = (memberRes.results ?? []).map((r) => ({
    coldKeyHex: r.cold_key_hex,
    versionFrom: r.version_from,
    versionTo: r.version_to,
    termExpiration: r.term_expiration,
    authorizedFrom: r.authorized_from,
    resignedAt: r.resigned_at,
  }));

  const hotToCold = new Map<string, string>();
  for (const h of hotRes.results ?? []) hotToCold.set(h.hot_key_hex, h.cold_key_hex);
  return { members, hotToCold };
}

/** Upserts committee members. Chunked at 16 rows (6 binds each) to stay under D1's 100-bind cap. */
export async function upsertCommitteeMembers(db: D1Database, members: CommitteeMemberTerm[]): Promise<void> {
  const CHUNK = 16;
  for (let i = 0; i < members.length; i += CHUNK) {
    const stmts = members.slice(i, i + CHUNK).map((m) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO committee_member
             (cold_key_hex, version_from, version_to, term_expiration, authorized_from, resigned_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(m.coldKeyHex, m.versionFrom, m.versionTo, m.termExpiration, m.authorizedFrom, m.resignedAt),
    );
    if (stmts.length > 0) await db.batch(stmts);
  }
}

/** Upserts hot-key to cold-key mappings. Chunked at 50 rows (2 binds each). */
export async function upsertCommitteeHotKeys(
  db: D1Database,
  pairs: { hotKeyHex: string; coldKeyHex: string }[],
): Promise<void> {
  const CHUNK = 50;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const stmts = pairs
      .slice(i, i + CHUNK)
      .map((p) =>
        db
          .prepare('INSERT OR REPLACE INTO committee_hot_key (hot_key_hex, cold_key_hex) VALUES (?, ?)')
          .bind(p.hotKeyHex, p.coldKeyHex),
      );
    if (stmts.length > 0) await db.batch(stmts);
  }
}

/**
 * Keeps the current committee version fresh from a live Koios committee_info
 * snapshot: registers newly rotated hot keys, updates the current members' term
 * expiration, and records a new resignation (a member no longer 'authorized').
 * The historical seed is protected: resigned_at is only ever set when still null
 * (COALESCE), so a past resignation epoch is never overwritten with "now", and
 * only rows of the current version (version_to IS NULL) are touched. `unknown`
 * counts Koios members absent from the current version, the signal that a new
 * committee was enacted and the seed needs extending (mirrors the NCL rot-alarm).
 */
export async function syncCurrentCommitteeMembership(
  db: D1Database,
  members: CommitteeMember[],
  currentEpoch: number | null,
): Promise<{ hotKeys: number; updated: number; unknown: number }> {
  const hotPairs = members
    .filter((m): m is CommitteeMember & { cc_hot_hex: string; cc_cold_hex: string } => !!m.cc_hot_hex && !!m.cc_cold_hex)
    .map((m) => ({ hotKeyHex: m.cc_hot_hex, coldKeyHex: m.cc_cold_hex }));
  await upsertCommitteeHotKeys(db, hotPairs);

  let updated = 0;
  let unknown = 0;
  for (const m of members) {
    if (!m.cc_cold_hex) continue;
    const resignedNow = m.status !== 'authorized' && currentEpoch != null ? currentEpoch : null;
    const res = await db
      .prepare(
        `UPDATE committee_member
           SET term_expiration = COALESCE(?, term_expiration),
               resigned_at = COALESCE(resigned_at, ?)
         WHERE cold_key_hex = ? AND version_to IS NULL`,
      )
      .bind(m.expiration_epoch, resignedNow, m.cc_cold_hex)
      .run();
    if ((res.meta.changes ?? 0) > 0) updated++;
    else unknown++;
  }
  return { hotKeys: hotPairs.length, updated, unknown };
}

// Every committee vote, current and superseded. drep_vote_history carries no
// hot key, so a superseded row borrows it from the voter's current row. The
// superseded rows matter once a cutoff applies: a member who voted in time and
// changed the vote during the tally epoch is judged on the in-time vote.
const ccVotesSql = (forOneAction: boolean): string => `
  SELECT ga_id, voter_hex, vote, block_time FROM drep_votes
   WHERE voter_role = 'ConstitutionalCommittee'${forOneAction ? ' AND ga_id = ?1' : ''}
  UNION ALL
  SELECT h.ga_id, v.voter_hex, h.vote, h.block_time FROM drep_vote_history h
    JOIN drep_votes v ON v.ga_id = h.ga_id AND v.voter_id = h.voter_id
   WHERE h.voter_role = 'ConstitutionalCommittee'${forOneAction ? ' AND h.ga_id = ?1' : ''}`;

type CcVoteDbRow = { ga_id: string; voter_hex: string | null; vote: string; block_time: number | null };

/** A stored vote string narrowed to the three ledger choices (anything else is skipped). */
function isCcChoice(vote: string): vote is CcVote['vote'] {
  return vote === 'Yes' || vote === 'No' || vote === 'Abstain';
}

function toCcVote(r: CcVoteDbRow): CcVote | null {
  if (!r.voter_hex || !isCcChoice(r.vote)) return null;
  return { hotKeyHex: r.voter_hex, vote: r.vote, blockTime: r.block_time };
}

/** The committee votes on one action, current and superseded, keyed by hot key, for the recompute. */
export async function getCommitteeVotes(db: D1Database, gaId: string): Promise<CcVote[]> {
  const res = await db
    .prepare(ccVotesSql(true))
    .bind(gaId)
    .all<CcVoteDbRow>();
  return (res.results ?? []).map(toCcVote).filter((v): v is CcVote => v != null);
}

/** Every committee vote grouped by action, one read for the whole recompute. */
async function getCommitteeVotesByAction(db: D1Database): Promise<Map<string, CcVote[]>> {
  const res = await db.prepare(ccVotesSql(false)).all<CcVoteDbRow>();
  const out = new Map<string, CcVote[]>();
  for (const r of res.results ?? []) {
    const v = toCcVote(r);
    if (!v) continue;
    const list = out.get(r.ga_id);
    if (list) list.push(v);
    else out.set(r.ga_id, [v]);
  }
  return out;
}

/** One CC vote on an action, with the fields the breakdown needs (identity + anchor). */
export interface CcVoteRow {
  voterId: string;
  hotKeyHex: string;
  vote: 'Yes' | 'No' | 'Abstain';
  blockTime: number | null;
  metaUrl: string | null;
}

/**
 * All CC votes on one action (role 'ConstitutionalCommittee'), for the breakdown.
 * voter_hex is lower-cased for stable joins with cc_member_name/committee_hot_key.
 */
export async function getActionCcVoteRows(db: D1Database, gaId: string): Promise<CcVoteRow[]> {
  const res = await db
    .prepare(
      `SELECT voter_id, lower(voter_hex) AS hot_key_hex, vote, block_time, meta_url
         FROM drep_votes
        WHERE ga_id = ? AND voter_role = 'ConstitutionalCommittee' AND voter_hex IS NOT NULL AND voter_hex <> ''`,
    )
    .bind(gaId)
    .all<{ voter_id: string; hot_key_hex: string; vote: string; block_time: number | null; meta_url: string | null }>();
  const out: CcVoteRow[] = [];
  for (const r of res.results ?? []) {
    if (!isCcChoice(r.vote)) continue;
    out.push({ voterId: r.voter_id, hotKeyHex: r.hot_key_hex, vote: r.vote, blockTime: r.block_time, metaUrl: r.meta_url });
  }
  return out;
}

/** One decided action's CC-relevant fields, for the analytics hub panel. */
export interface DecidedCcAction {
  gaId: string;
  title: string | null;
  topicSlug: string | null;
  type: string;
  status: string;
  decidedEpoch: number;
  ratifiedEpoch: number | null;
  expiryEpoch: number | null;
  submittedAt: number | null;
  ccYesPct: number | null;
  thresholdsJson: string | null;
}

/** Every decided action, for the hub panel. The caller filters by isCcEligible. */
export async function listDecidedCcActions(db: D1Database): Promise<DecidedCcAction[]> {
  const res = await db
    .prepare(
      `SELECT g.id, g.title, t.slug AS topic_slug, g.type, g.status, g.decided_epoch, g.ratified_epoch, g.expiry_epoch, g.submitted_at, g.cc_yes_pct, g.thresholds_json
         FROM governance_actions g
         LEFT JOIN topics t ON t.id = g.topic_id
        WHERE g.decided_epoch IS NOT NULL AND ${concludedStatusSql('g')}`,
    )
    .all<{
      id: string;
      title: string | null;
      topic_slug: string | null;
      type: string;
      status: string;
      decided_epoch: number;
      ratified_epoch: number | null;
      expiry_epoch: number | null;
      submitted_at: number | null;
      cc_yes_pct: number | null;
      thresholds_json: string | null;
    }>();
  return (res.results ?? []).map((r) => ({
    gaId: r.id,
    title: r.title,
    topicSlug: r.topic_slug,
    type: r.type,
    status: r.status,
    decidedEpoch: r.decided_epoch,
    ratifiedEpoch: r.ratified_epoch,
    expiryEpoch: r.expiry_epoch,
    submittedAt: r.submitted_at,
    ccYesPct: r.cc_yes_pct,
    thresholdsJson: r.thresholds_json,
  }));
}

/**
 * All CC votes on every decided action, grouped by ga_id, for the hub panel.
 * Same filters and vote narrowing as getActionCcVoteRows, batched across actions
 * so the hub and the per-action breakdown always agree.
 */
export async function listDecidedCcVoteRows(db: D1Database): Promise<Map<string, CcVoteRow[]>> {
  const res = await db
    .prepare(
      `SELECT drep_votes.ga_id AS ga_id, voter_id, lower(voter_hex) AS hot_key_hex, vote, block_time, meta_url
         FROM drep_votes
         JOIN governance_actions g ON g.id = drep_votes.ga_id AND g.decided_epoch IS NOT NULL
              AND ${concludedStatusSql('g')}
        WHERE voter_role = 'ConstitutionalCommittee' AND voter_hex IS NOT NULL AND voter_hex <> ''`,
    )
    .all<{
      ga_id: string;
      voter_id: string;
      hot_key_hex: string;
      vote: string;
      block_time: number | null;
      meta_url: string | null;
    }>();
  const out = new Map<string, CcVoteRow[]>();
  for (const r of res.results ?? []) {
    if (!isCcChoice(r.vote)) continue;
    const row: CcVoteRow = { voterId: r.voter_id, hotKeyHex: r.hot_key_hex, vote: r.vote, blockTime: r.block_time, metaUrl: r.meta_url };
    const existing = out.get(r.ga_id);
    if (existing) existing.push(row);
    else out.set(r.ga_id, [row]);
  }
  return out;
}

/** The loaded membership timeline, read once and shared across a sync run. */
export interface CommitteeTimeline {
  members: CommitteeMemberTerm[];
  hotToCold: Map<string, string>;
}

/**
 * Ledger-exact committee tally for one action, computed from the local
 * per-voter votes and the membership timeline (the same math as
 * recomputeCommitteePct). Votes cast from the start of the boundary epoch on do
 * not count (see ccTallyPct). Without a network config every vote counts. Returns null when it cannot improve on Koios: empty
 * timeline (preprod), unknown epoch, no local CC votes yet, or no active
 * committee at that epoch. The tally sync uses this to write ledger-exact cc_*
 * values in the first place, so a later tally pass can never revert an already
 * recomputed action back to the raw Koios summary.
 */
export async function ledgerCcTally(
  db: D1Database,
  timeline: CommitteeTimeline,
  gaId: string,
  boundaryEpoch: number | null,
  cfg: NetworkConfig | null,
): Promise<{ yesPct: number; noPct: number; yes: number; no: number; abstain: number } | null> {
  if (timeline.members.length === 0 || boundaryEpoch == null) return null;
  const votes = await getCommitteeVotes(db, gaId);
  if (votes.length === 0) return null;
  const t = ccTallyPct(votes, timeline.members, timeline.hotToCold, boundaryEpoch, cfg ? epochStartUnix(boundaryEpoch, cfg) : null);
  if (t.yesPct == null || t.noPct == null) return null;
  return { yesPct: t.yesPct, noPct: t.noPct, yes: t.yes, no: t.no, abstain: t.abstain };
}

interface RecomputeRow {
  id: string;
  status: string;
  decidedEpoch: number | null;
  ratifiedEpoch: number | null;
  expiryEpoch: number | null;
  ccYesPct: number | null;
  ccNoPct: number | null;
  ccYes: number | null;
  ccNo: number | null;
  ccAbstain: number | null;
}

/**
 * Every action with its stored pct/counts and decided epoch. All of them on
 * purpose: a capped scan without an order returns whatever the storage yields
 * first, on prod the oldest rows, so the newest actions were never visited. The
 * caller keeps those with committee votes. The set is small (low hundreds).
 */
async function getActionsForCommitteeRecompute(db: D1Database): Promise<RecomputeRow[]> {
  const res = await db
    .prepare(
      `SELECT id, status, decided_epoch, ratified_epoch, expiry_epoch, cc_yes_pct, cc_no_pct, cc_yes, cc_no, cc_abstain
         FROM governance_actions`,
    )
    .all<{
      id: string;
      status: string;
      decided_epoch: number | null;
      ratified_epoch: number | null;
      expiry_epoch: number | null;
      cc_yes_pct: number | null;
      cc_no_pct: number | null;
      cc_yes: number | null;
      cc_no: number | null;
      cc_abstain: number | null;
    }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    status: r.status,
    decidedEpoch: r.decided_epoch,
    ratifiedEpoch: r.ratified_epoch,
    expiryEpoch: r.expiry_epoch,
    ccYesPct: r.cc_yes_pct,
    ccNoPct: r.cc_no_pct,
    ccYes: r.cc_yes,
    ccNo: r.cc_no,
    ccAbstain: r.cc_abstain,
  }));
}

export interface CommitteePctRecomputeResult {
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * Replaces the stored Koios committee_yes_pct with the ledger-exact recompute for
 * every action that has committee votes. Resolves the committee at the action's
 * decision boundary (or the next transition while still open, see
 * committeeBoundaryForAction), dedupes the per-voter votes per member and, once
 * counts only votes cast before the boundary epoch. Only-changed: writes only
 * when a value actually moves, so a settled action converges after one pass.
 * Skips (keeps the Koios value) when the committee at that epoch is unknown
 * (data older than the seed). Three reads and one batched write per run.
 */
export async function recomputeCommitteePct(
  db: D1Database,
  currentEpoch: number | null,
  cfg: NetworkConfig,
): Promise<CommitteePctRecomputeResult> {
  const [{ members, hotToCold }, allActions, votesByAction] = await Promise.all([
    getCommitteeTimeline(db),
    getActionsForCommitteeRecompute(db),
    getCommitteeVotesByAction(db),
  ]);
  if (members.length === 0) return { scanned: 0, updated: 0, skipped: 0 };
  const actions = allActions.filter((a) => votesByAction.has(a.id));
  const writes: D1PreparedStatement[] = [];
  let skipped = 0;
  for (const a of actions) {
    const boundary = committeeBoundaryForAction(a, currentEpoch);
    if (boundary == null) {
      skipped++;
      continue;
    }
    const votes = votesByAction.get(a.id) ?? [];
    const { yesPct, noPct, yes, no, abstain } = ccTallyPct(votes, members, hotToCold, boundary, epochStartUnix(boundary, cfg));
    if (yesPct == null || noPct == null) {
      skipped++;
      continue;
    }
    if (
      yesPct !== a.ccYesPct ||
      noPct !== a.ccNoPct ||
      yes !== a.ccYes ||
      no !== a.ccNo ||
      abstain !== a.ccAbstain
    ) {
      writes.push(
        db
          .prepare('UPDATE governance_actions SET cc_yes_pct = ?, cc_no_pct = ?, cc_yes = ?, cc_no = ?, cc_abstain = ? WHERE id = ?')
          .bind(yesPct, noPct, yes, no, abstain, a.id),
      );
    }
  }
  const CHUNK = 50;
  for (let i = 0; i < writes.length; i += CHUNK) await db.batch(writes.slice(i, i + CHUNK));
  return { scanned: actions.length, updated: writes.length, skipped };
}
