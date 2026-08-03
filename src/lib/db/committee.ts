// Read and write the constitutional committee membership timeline (the
// committee_member / committee_hot_key tables). getCommitteeTimeline loads the
// full timeline for the yes-percentage recompute; the upserts are used by the
// live Koios sync and the one-time historical seed. Distinct from
// koios/committee.ts, which is pure math on a single live committee_info snapshot.
import type { CommitteeMember } from '../koios/client.js';
import type { CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import { ccTallyPct, type CcVote } from '../koios/corrections.js';

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

/** The committee votes on one action, keyed by hot key, for the recompute. */
export async function getCommitteeVotes(db: D1Database, gaId: string): Promise<CcVote[]> {
  const res = await db
    .prepare(`SELECT voter_hex, vote, block_time FROM drep_votes WHERE ga_id = ? AND voter_role = 'ConstitutionalCommittee'`)
    .bind(gaId)
    .all<{ voter_hex: string | null; vote: string; block_time: number | null }>();
  const out: CcVote[] = [];
  for (const r of res.results ?? []) {
    if (!r.voter_hex) continue;
    if (r.vote !== 'Yes' && r.vote !== 'No' && r.vote !== 'Abstain') continue;
    out.push({ hotKeyHex: r.voter_hex, vote: r.vote, blockTime: r.block_time });
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
 * recomputeCommitteePct). Returns null when it cannot improve on Koios: empty
 * timeline (preprod), unknown epoch, no local CC votes yet, or no active
 * committee at that epoch. The tally sync uses this to write ledger-exact cc_*
 * values in the first place, so a later tally pass can never revert an already
 * recomputed action back to the raw Koios summary.
 */
export async function ledgerCcTally(
  db: D1Database,
  timeline: CommitteeTimeline,
  gaId: string,
  epoch: number | null,
): Promise<{ yesPct: number; noPct: number; yes: number; no: number; abstain: number } | null> {
  if (timeline.members.length === 0 || epoch == null) return null;
  const votes = await getCommitteeVotes(db, gaId);
  if (votes.length === 0) return null;
  const t = ccTallyPct(votes, timeline.members, timeline.hotToCold, epoch);
  if (t.yesPct == null || t.noPct == null) return null;
  return { yesPct: t.yesPct, noPct: t.noPct, yes: t.yes, no: t.no, abstain: t.abstain };
}

interface RecomputeRow {
  id: string;
  decidedEpoch: number | null;
  ccYesPct: number | null;
  ccNoPct: number | null;
  ccYes: number | null;
  ccNo: number | null;
  ccAbstain: number | null;
}

/** Actions that carry committee votes, with their stored pct/counts and decided epoch. */
async function getActionsForCommitteeRecompute(db: D1Database, limit: number): Promise<RecomputeRow[]> {
  const res = await db
    .prepare(
      `SELECT ga.id, ga.decided_epoch, ga.cc_yes_pct, ga.cc_no_pct, ga.cc_yes, ga.cc_no, ga.cc_abstain
         FROM governance_actions ga
        WHERE EXISTS (SELECT 1 FROM drep_votes v WHERE v.ga_id = ga.id AND v.voter_role = 'ConstitutionalCommittee')
        LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: string;
      decided_epoch: number | null;
      cc_yes_pct: number | null;
      cc_no_pct: number | null;
      cc_yes: number | null;
      cc_no: number | null;
      cc_abstain: number | null;
    }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    decidedEpoch: r.decided_epoch,
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
 * every action that has committee votes. Uses the action's decided epoch (or the
 * current epoch while still open) to resolve the committee size, and the per-voter
 * votes deduped per member. Only-changed: writes only when the pct actually moves,
 * so a settled action converges after one pass. Skips (keeps the Koios value) when
 * the committee at that epoch is unknown (data older than the seed).
 */
export async function recomputeCommitteePct(
  db: D1Database,
  currentEpoch: number | null,
  limit: number,
): Promise<CommitteePctRecomputeResult> {
  const { members, hotToCold } = await getCommitteeTimeline(db);
  if (members.length === 0) return { scanned: 0, updated: 0, skipped: 0 };
  const actions = await getActionsForCommitteeRecompute(db, limit);
  let updated = 0;
  let skipped = 0;
  for (const a of actions) {
    const epoch = a.decidedEpoch ?? currentEpoch;
    if (epoch == null) {
      skipped++;
      continue;
    }
    const votes = await getCommitteeVotes(db, a.id);
    const { yesPct, noPct, yes, no, abstain } = ccTallyPct(votes, members, hotToCold, epoch);
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
      await db
        .prepare('UPDATE governance_actions SET cc_yes_pct = ?, cc_no_pct = ?, cc_yes = ?, cc_no = ?, cc_abstain = ? WHERE id = ?')
        .bind(yesPct, noPct, yes, no, abstain, a.id)
        .run();
      updated++;
    }
  }
  return { scanned: actions.length, updated, skipped };
}
