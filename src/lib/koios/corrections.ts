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
 * Null when no committee is active at the epoch (membership unknown), so the caller
 * can fall back to Koios rather than show a wrong figure.
 */
export function ccTallyPct(
  votes: CcVote[],
  members: CommitteeMemberTerm[],
  hotToCold: Map<string, string>,
  ratifiedEpoch: number,
): { yesPct: number | null; noPct: number | null } {
  const active = activeCommitteeMembersAt(members, ratifiedEpoch);
  if (active.size === 0) return { yesPct: null, noPct: null };

  const finalByMember = new Map<string, { vote: CcVote['vote']; blockTime: number }>();
  for (const v of votes) {
    const cold = hotToCold.get(v.hotKeyHex);
    if (cold == null || !active.has(cold)) continue;
    const bt = v.blockTime ?? 0;
    const prev = finalByMember.get(cold);
    if (prev == null || bt >= prev.blockTime) finalByMember.set(cold, { vote: v.vote, blockTime: bt });
  }

  let yes = 0;
  let abstain = 0;
  for (const { vote } of finalByMember.values()) {
    if (vote === 'Yes') yes++;
    else if (vote === 'Abstain') abstain++;
  }

  const denom = active.size - abstain;
  if (denom <= 0) return { yesPct: null, noPct: null };
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return { yesPct: round2((yes / denom) * 100), noPct: round2(((denom - yes) / denom) * 100) };
}
