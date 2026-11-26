// Assembles the CC vote breakdown rows for one action. Pure, no I/O. Eligible
// members are those counted at the action's committee boundary (the same set
// the CC tally resolves, see committeeBoundaryForAction), so breakdown and tally
// never disagree. Votes are
// deduped with finalCcVoteByMember (the same the tally uses). These rows are NOT
// DReps: the caller renders them directly (identicon + name), never through
// voterDescriptor/AuthorIdentity/drepPath. Ballots of credentials the boundary does
// not count come from buildUncountedCcPositions, a separate list the tally never sees.
import { activeCommitteeMembersAtBoundary, committeeStanding, versionCovers, type CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import { finalCcVoteByMember } from '../koios/corrections.js';
import type { CcVoteRow } from '../db/committee.js';
import type { CcNameIndex } from './ccNames.js';

export interface CcPositionRow {
  coldKeyHex: string;
  hotKeyHex: string | null;
  voterId: string | null;
  displayName: string | null;
  vote: 'Yes' | 'No' | 'Abstain' | null;
  standing: 'Active' | 'Resigned' | 'Expired';
  termExpiration: number | null;
  rationale: 'view' | 'unavailable' | 'none';
  bodyHtml: string | null;
}

/** A ballot cast under a committee credential that does not count at the action's boundary. */
export interface CcUncountedRow {
  /** Null when the hot key maps to no known cold credential. */
  coldKeyHex: string | null;
  hotKeyHex: string;
  voterId: string;
  displayName: string | null;
  vote: 'Yes' | 'No' | 'Abstain';
  rationale: 'view' | 'unavailable' | 'none';
  bodyHtml: string | null;
}

export type RationaleStatuses = Map<string, { bodyHtml: string | null; status: string }>;

const VOTE_ORDER: Record<string, number> = { Yes: 0, No: 1, Abstain: 2 };

export function rationaleFor(
  vote: { voterId: string; metaUrl: string | null },
  rationales: RationaleStatuses,
): { rationale: 'view' | 'unavailable' | 'none'; bodyHtml: string | null } {
  const rat = rationales.get(vote.voterId);
  if (rat?.status === 'ok' && rat.bodyHtml) return { rationale: 'view', bodyHtml: rat.bodyHtml };
  return { rationale: vote.metaUrl ? 'unavailable' : 'none', bodyHtml: null };
}

function termRowAt(members: CommitteeMemberTerm[], coldKeyHex: string, epoch: number): CommitteeMemberTerm | null {
  return members.find((m) => m.coldKeyHex === coldKeyHex && versionCovers(m, epoch)) ?? null;
}

// Standing at the next transition after the current epoch, shown as neutral
// context (not an error). A seat without an authorized hot key is still a seat.
function standingAt(m: CommitteeMemberTerm | null, currentEpoch: number | null): 'Active' | 'Resigned' | 'Expired' {
  if (m == null || currentEpoch == null) return 'Active';
  const s = committeeStanding(m, currentEpoch + 1);
  return s === 'resigned' ? 'Resigned' : s === 'expired' ? 'Expired' : 'Active';
}

export function buildCcPositions(input: {
  members: CommitteeMemberTerm[];
  hotToCold: Map<string, string>;
  votes: CcVoteRow[];
  /** The boundary whose committee judges the action (committeeBoundaryForAction). */
  epoch: number | null;
  currentEpoch: number | null;
  nameIndex: CcNameIndex;
  rationales: RationaleStatuses;
}): CcPositionRow[] {
  const { members, hotToCold, votes, epoch, currentEpoch, nameIndex, rationales } = input;
  if (epoch == null) return [];
  const active = activeCommitteeMembersAtBoundary(members, epoch);
  if (active.size === 0) return [];

  const coldToHot = new Map<string, string>();
  for (const [hot, cold] of hotToCold) if (!coldToHot.has(cold)) coldToHot.set(cold, hot);

  const finalByCold = finalCcVoteByMember(votes, members, hotToCold, epoch);

  const rows: CcPositionRow[] = [];
  for (const cold of active) {
    const term = termRowAt(members, cold, epoch);
    const winning = finalByCold.get(cold) ?? null;
    const hotKeyHex = winning?.hotKeyHex ?? coldToHot.get(cold) ?? null;
    const displayName = winning ? nameIndex.byHot(winning.hotKeyHex) ?? nameIndex.byCold(cold) : nameIndex.byCold(cold);

    const { rationale, bodyHtml } = winning ? rationaleFor(winning, rationales) : { rationale: 'none' as const, bodyHtml: null };

    rows.push({
      coldKeyHex: cold, hotKeyHex, voterId: winning?.voterId ?? null, displayName,
      vote: winning?.vote ?? null, standing: standingAt(term, currentEpoch),
      termExpiration: term?.termExpiration ?? null, rationale, bodyHtml,
    });
  }

  const rank = (r: CcPositionRow) => (r.vote == null ? 3 : VOTE_ORDER[r.vote]);
  const label = (r: CcPositionRow) => (r.displayName ?? r.coldKeyHex).toLowerCase();
  rows.sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)) || a.coldKeyHex.localeCompare(b.coldKeyHex));
  return rows;
}

/**
 * Ballots on the action from committee credentials the ledger does not count at
 * its boundary: a member removed by a committee change, a term that ran out, a
 * resignation, or a seat that came back under a new credential. They stay on the
 * record under the counted committee and never enter its count. One row per
 * credential (its latest ballot), keyed by the cold credential, or by the hot key
 * when no cold credential is known for it.
 */
export function buildUncountedCcPositions(input: {
  members: CommitteeMemberTerm[];
  hotToCold: Map<string, string>;
  votes: CcVoteRow[];
  /** The boundary whose committee judges the action (committeeBoundaryForAction). */
  epoch: number | null;
  nameIndex: CcNameIndex;
  rationales: RationaleStatuses;
}): CcUncountedRow[] {
  const { members, hotToCold, votes, epoch, nameIndex, rationales } = input;
  if (epoch == null) return [];
  const active = activeCommitteeMembersAtBoundary(members, epoch);
  if (active.size === 0) return [];

  const latest = new Map<string, CcVoteRow>();
  for (const v of votes) {
    const cold = hotToCold.get(v.hotKeyHex);
    if (cold != null && active.has(cold)) continue;
    const key = cold ?? `hot:${v.hotKeyHex}`;
    const prev = latest.get(key);
    if (prev == null || (v.blockTime ?? 0) >= (prev.blockTime ?? 0)) latest.set(key, v);
  }

  const rows: CcUncountedRow[] = [];
  for (const v of latest.values()) {
    const cold = hotToCold.get(v.hotKeyHex) ?? null;
    rows.push({
      coldKeyHex: cold, hotKeyHex: v.hotKeyHex, voterId: v.voterId,
      displayName: nameIndex.byHot(v.hotKeyHex) ?? (cold ? nameIndex.byCold(cold) : null),
      vote: v.vote, ...rationaleFor(v, rationales),
    });
  }

  const label = (r: CcUncountedRow) => (r.displayName ?? r.coldKeyHex ?? r.hotKeyHex).toLowerCase();
  rows.sort((a, b) => VOTE_ORDER[a.vote] - VOTE_ORDER[b.vote] || label(a).localeCompare(label(b)) || a.voterId.localeCompare(b.voterId));
  return rows;
}
