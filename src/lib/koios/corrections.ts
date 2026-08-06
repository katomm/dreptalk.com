// Ledger-accurate corrections for known Koios upstream bugs in governance vote
// tallies. Koios' aggregated pool percentages match the Conway ledger for most
// action types, but a few need a recompute from the raw power buckets. Every such
// Koios workaround lives here, in one discoverable place with its rationale,
// instead of being scattered through the view and sync layers (view.ts stays free
// of ledger rules; tallySync.ts imports these when mapping a summary to the stored
// tally). Pure functions, no I/O.
import type { VotingSummary } from './client.js';
import { activeCommitteeMembersAt, type CommitteeMemberTerm } from './committeeTimeline.js';

/** Parses a Koios lovelace power string to a number; null when absent. The
    magnitudes (up to ~2.1e16) exceed Number.MAX_SAFE_INTEGER, but the lost
    precision is in the lowest lovelace and irrelevant to a 2-decimal percentage. */
function powerNum(v: string | null | undefined): number | null {
  return v == null ? null : Number(v);
}

/**
 * SPO yes/no percentages for the tally. Koios' pool_yes_pct / pool_no_pct are
 * correct for every action type EXCEPT HardForkInitiation. The Conway ledger does
 * NOT honour the always-abstain reward-account default for hard forks: a pool that
 * did not vote (including one whose reward account delegates to AlwaysAbstain or
 * AlwaysNoConfidence) counts as No and stays in the denominator; only an explicit
 * Abstain vote leaves it. (cardano-ledger Conway Ratify.hs, spoAcceptedRatio:
 * "For HardForkInitiation ... if an SPO didn't vote, their vote will always count
 * as No.") Koios instead drops the always-abstain stake from the denominator for
 * hard forks too, which inflates yes%. For that one type we recompute from the raw
 * power buckets, folding the always-abstain / always-no-confidence stake back into
 * the No side:
 *   yesPct = yes / (yes + no + always_abstain + always_no_confidence)
 * Falls back to Koios' percentages for every other type, and for hard forks when
 * the power fields are absent (older Koios) or the denominator is zero.
 */
export function spoTallyPct(s: VotingSummary): { yesPct: number | null; noPct: number | null } {
  const fallback = { yesPct: s.pool_yes_pct ?? null, noPct: s.pool_no_pct ?? null };
  if (s.proposal_type !== 'HardForkInitiation') return fallback;
  const yes = powerNum(s.pool_active_yes_vote_power);
  const no = powerNum(s.pool_no_vote_power);
  if (yes == null || no == null) return fallback;
  const noSide =
    no +
    (powerNum(s.pool_passive_always_abstain_vote_power) ?? 0) +
    (powerNum(s.pool_passive_always_no_confidence_vote_power) ?? 0);
  const denom = yes + noSide;
  if (denom <= 0) return fallback;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return { yesPct: round2((yes / denom) * 100), noPct: round2((noSide / denom) * 100) };
}

/** Eligible SPO voting stake (lovelace): the denominator for SPO turnout. Sums the
    active yes/abstain, both passive default buckets, and pool_no_vote_power (which
    already folds in active no plus non-voting-default no). Absent summands count as 0;
    null only when every pool power field is absent (older Koios without power data). */
export function spoEligiblePower(s: VotingSummary | null): number | null {
  if (!s) return null;
  const parts = [
    s.pool_active_yes_vote_power,
    s.pool_active_abstain_vote_power,
    s.pool_passive_always_abstain_vote_power,
    s.pool_passive_always_no_confidence_vote_power,
    s.pool_no_vote_power,
  ];
  if (parts.every((v) => v == null)) return null;
  return parts.reduce((sum, v) => sum + (v == null ? 0 : Number(v)), 0);
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
 * is not active at `epoch`, then keep the latest block time per member. The one
 * dedup used by the tally, the trend chart, and the breakdown, so they agree.
 */
export function finalCcVoteByMember<T extends { hotKeyHex: string; blockTime: number | null }>(
  votes: T[],
  members: CommitteeMemberTerm[],
  hotToCold: Map<string, string>,
  epoch: number,
): Map<string, T> {
  const active = activeCommitteeMembersAt(members, epoch);
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
 * per-voter votes and the committee's composition at the action's decided epoch:
 *
 * 1. Map each vote's hot key to its cold-key member; ignore votes from members not
 *    active at that epoch (resigned or term-expired), so a stale vote never counts.
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
  ratifiedEpoch: number,
): { yesPct: number | null; noPct: number | null; yes: number; no: number; abstain: number } {
  const active = activeCommitteeMembersAt(members, ratifiedEpoch);
  if (active.size === 0) return { yesPct: null, noPct: null, yes: 0, no: 0, abstain: 0 };

  const finalByMember = finalCcVoteByMember(votes, members, hotToCold, ratifiedEpoch);

  let yes = 0;
  let no = 0;
  let abstain = 0;
  for (const { vote } of finalByMember.values()) {
    if (vote === 'Yes') yes++;
    else if (vote === 'No') no++;
    else abstain++;
  }

  const denom = active.size - abstain;
  const round2 = (n: number) => Math.round(n * 100) / 100;
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
 * stable cold key. Members not active at ratifiedEpoch, and votes with an unknown
 * hot key, are dropped. Used by the voting-trend chart for the CC timeline.
 */
export function ccFinalVotesByMember(
  votes: CcVote[],
  members: CommitteeMemberTerm[],
  hotToCold: Map<string, string>,
  ratifiedEpoch: number,
): CcMemberFinalVote[] {
  const finalByMember = finalCcVoteByMember(votes, members, hotToCold, ratifiedEpoch);
  return [...finalByMember.entries()].map(([coldKeyHex, v]) => ({
    coldKeyHex,
    vote: v.vote,
    blockTime: v.blockTime ?? 0,
  }));
}
