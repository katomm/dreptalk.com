// Ledger-accurate corrections for known Koios upstream bugs in governance vote
// tallies. Koios' aggregated DRep and pool percentages match the Conway ledger, the
// committee tally needs a recompute from the counted members. Every such
// Koios workaround lives here, in one discoverable place with its rationale,
// instead of being scattered through the view and sync layers (view.ts stays free
// of ledger rules; tallySync.ts imports these when mapping a summary to the stored
// tally). Pure functions, no I/O.
import type { VotingSummary } from './client.js';
import { activeCommitteeMembersAtBoundary, type CommitteeMemberTerm } from './committeeTimeline.js';
import { round2 } from '../format/pct.js';
import { alwaysAbstainIsNoSide } from '../governance/fullStakeView.js';

/**
 * Total eligible voting stake (lovelace) for one body: the turnout denominator,
 * and the base the full-stake breakdown is drawn against.
 *
 *   eligible = active yes + no side + active abstain + always-abstain
 *
 * except for the SPO vote on a hard fork, where the ledger counts the always-abstain
 * pools as No and Koios already folds them into pool_no_vote_power (see
 * alwaysAbstainIsNoSide in governance/fullStakeView.ts for the verification), so the
 * bucket is not added a second time. Koios used to report it separately for hard
 * forks and a recompute here folded it back in. Since Koios changed that, its
 * pool_yes_pct is the ledger figure for every action type and the tally takes it as is.
 *
 * The No side (drep_no_vote_power / pool_no_vote_power) is a single Koios figure
 * that already folds in three things: the cast No votes, the non-voting default No,
 * and the always-no-confidence bucket. That last inclusion is easy to get wrong and
 * was wrong here: the reported percentage is exactly yes / (yes + no_vote_power),
 * verified across ParameterChange, TreasuryWithdrawals, InfoAction and NewCommittee
 * on mainnet, and adding always-no-confidence a second time breaks the identity
 * (65.92 becomes 64.03). So the always-no-confidence power must NEVER be summed in
 * here on top of the No side.
 *
 * Null when Koios served neither a No side nor any power bucket (older responses),
 * so callers can degrade instead of dividing by a fabricated denominator.
 */
export function eligibleStake(s: VotingSummary | null, body: 'DRep' | 'SPO'): number | null {
  if (!s) return null;
  const parts =
    body === 'DRep'
      ? [
          s.drep_active_yes_vote_power,
          s.drep_no_vote_power,
          s.drep_active_abstain_vote_power,
          s.drep_always_abstain_vote_power,
        ]
      : [
          s.pool_active_yes_vote_power,
          s.pool_no_vote_power,
          s.pool_active_abstain_vote_power,
          alwaysAbstainIsNoSide(s.proposal_type ?? '', 'SPO') ? null : s.pool_passive_always_abstain_vote_power,
        ];
  if (parts.every((v) => v == null)) return null;
  return parts.reduce((sum, v) => sum + (v == null ? 0 : Number(v)), 0);
}

/** Eligible SPO voting stake (lovelace), the SPO case of eligibleStake. Kept as a
    named export because the tally mapping and the view layer both read it by name. */
export function spoEligiblePower(s: VotingSummary | null): number | null {
  return eligibleStake(s, 'SPO');
}

/** A single on-chain committee vote, keyed by the voter's hot-key hash. */
export interface CcVote {
  hotKeyHex: string;
  vote: 'Yes' | 'No' | 'Abstain';
  /** On-chain block time; when a member re-voted or rotated hot keys, the latest wins. */
  blockTime: number | null;
}

/**
 * The winning vote row per active committee member: drop hot keys whose member
 * is not counted at the boundary that opens `boundaryEpoch`, then keep the
 * latest block time per member. The one dedup used by the tally, the trend
 * chart, and the breakdown, so they agree.
 */
export function finalCcVoteByMember<T extends { hotKeyHex: string; blockTime: number | null }>(
  votes: T[],
  members: CommitteeMemberTerm[],
  hotToCold: Map<string, string>,
  boundaryEpoch: number,
): Map<string, T> {
  const active = activeCommitteeMembersAtBoundary(members, boundaryEpoch);
  const finalByMember = new Map<string, T>();
  for (const v of votes) {
    const cold = hotToCold.get(v.hotKeyHex);
    if (cold == null || !active.has(cold)) continue;
    const prev = finalByMember.get(cold);
    if (prev == null || (v.blockTime ?? 0) >= (prev.blockTime ?? 0)) finalByMember.set(cold, v);
  }
  return finalByMember;
}

/**
 * Ledger-exact committee yes/no percentages, replacing Koios' committee_yes_pct.
 * Koios' summary is wrong for several actions: it double-counts a duplicate hot-key
 * registration and keeps a resigned member in the denominator. We recompute from the
 * per-voter votes and the committee's composition at the action's decision boundary
 * (for an open action, the next transition):
 *
 * 1. Map each vote's hot key to its cold-key member; ignore votes from members not
 *    counted at that boundary (resigned, term-expired, not yet authorized), so a
 *    stale vote never counts.
 * 2. Keep one final vote per member (latest block time), collapsing rotations/re-votes.
 * 3. Conway rule: abstaining members leave the denominator, everyone else active
 *    (No, or did not vote) stays in it. yesPct = yes / (active - abstain).
 *
 * Also returns the deduped per-member vote counts (yes/no/abstain), so the stored
 * counts stay consistent with the percentage (Koios' raw counts double-count a
 * rotated/duplicate hot key). yesPct/noPct are null when no committee is active at
 * the epoch (membership unknown), so the caller can fall back to Koios; the counts
 * are still returned.
 */
export function ccTallyPct(
  votes: CcVote[],
  members: CommitteeMemberTerm[],
  hotToCold: Map<string, string>,
  boundaryEpoch: number,
): { yesPct: number | null; noPct: number | null; yes: number; no: number; abstain: number } {
  const active = activeCommitteeMembersAtBoundary(members, boundaryEpoch);
  if (active.size === 0) return { yesPct: null, noPct: null, yes: 0, no: 0, abstain: 0 };

  const finalByMember = finalCcVoteByMember(votes, members, hotToCold, boundaryEpoch);

  let yes = 0;
  let no = 0;
  let abstain = 0;
  for (const { vote } of finalByMember.values()) {
    if (vote === 'Yes') yes++;
    else if (vote === 'No') no++;
    else abstain++;
  }

  const denom = active.size - abstain;
  const yesPct = denom <= 0 ? null : round2((yes / denom) * 100);
  const noPct = denom <= 0 ? null : round2(((denom - yes) / denom) * 100);
  return { yesPct, noPct, yes, no, abstain };
}

/** One counted committee member's final vote, with its on-chain timestamp. */
export interface CcMemberFinalVote {
  coldKeyHex: string;
  vote: 'Yes' | 'No' | 'Abstain';
  blockTime: number;
}

/**
 * The final vote per active committee member, resolving hot-key rotations and
 * re-votes to the latest-blockTime vote (same dedup as ccTallyPct), keyed by the
 * stable cold key. Members not counted at the boundary, and votes with an unknown
 * hot key, are dropped. Used by the voting-trend chart for the CC timeline.
 */
export function ccFinalVotesByMember(
  votes: CcVote[],
  members: CommitteeMemberTerm[],
  hotToCold: Map<string, string>,
  boundaryEpoch: number,
): CcMemberFinalVote[] {
  const finalByMember = finalCcVoteByMember(votes, members, hotToCold, boundaryEpoch);
  return [...finalByMember.entries()].map(([coldKeyHex, v]) => ({
    coldKeyHex,
    vote: v.vote,
    blockTime: v.blockTime ?? 0,
  }));
}
