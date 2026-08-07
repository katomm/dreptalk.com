// Assembles the CC vote breakdown rows for one action. Pure, no I/O. Eligible
// members are those active at the epoch (the same set activeCommitteeMembersAt
// computes for the CC tally), so breakdown and tally never disagree. Votes are
// deduped with finalCcVoteByMember (the same the tally uses). These rows are NOT
// DReps: the caller renders them directly (identicon + name), never through
// voterDescriptor/AuthorIdentity/drepPath.
import { activeCommitteeMembersAt, type CommitteeMemberTerm } from '../koios/committeeTimeline.js';
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

const VOTE_ORDER: Record<string, number> = { Yes: 0, No: 1, Abstain: 2 };

function termRowAt(members: CommitteeMemberTerm[], coldKeyHex: string, epoch: number): CommitteeMemberTerm | null {
  return members.find((m) => m.coldKeyHex === coldKeyHex && m.versionFrom <= epoch && (m.versionTo == null || m.versionTo >= epoch)) ?? null;
}

// Standing relative to the current epoch, shown as neutral context (not an error).
function standingAt(m: CommitteeMemberTerm | null, currentEpoch: number | null): 'Active' | 'Resigned' | 'Expired' {
  if (m == null || currentEpoch == null) return 'Active';
  if (m.resignedAt != null && m.resignedAt <= currentEpoch) return 'Resigned';
  if (m.termExpiration < currentEpoch) return 'Expired';
  return 'Active';
}

export function buildCcPositions(input: {
  members: CommitteeMemberTerm[];
  hotToCold: Map<string, string>;
  votes: CcVoteRow[];
  epoch: number | null;
  currentEpoch: number | null;
  nameIndex: CcNameIndex;
  rationales: Map<string, { bodyHtml: string | null; status: string }>;
}): CcPositionRow[] {
  const { members, hotToCold, votes, epoch, currentEpoch, nameIndex, rationales } = input;
  if (epoch == null) return [];
  const active = activeCommitteeMembersAt(members, epoch);
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

    let rationale: CcPositionRow['rationale'] = 'none';
    let bodyHtml: string | null = null;
    if (winning) {
      const rat = rationales.get(winning.voterId);
      if (rat?.status === 'ok' && rat.bodyHtml) { rationale = 'view'; bodyHtml = rat.bodyHtml; }
      else if (winning.metaUrl) rationale = 'unavailable';
    }

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
