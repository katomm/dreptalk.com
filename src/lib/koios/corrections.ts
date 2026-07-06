// Ledger-accurate corrections for known Koios upstream bugs in governance vote
// tallies. Koios' aggregated pool percentages match the Conway ledger for most
// action types, but a few need a recompute from the raw power buckets. Every such
// Koios workaround lives here, in one discoverable place with its rationale,
// instead of being scattered through the view and sync layers (view.ts stays free
// of ledger rules; tallySync.ts imports these when mapping a summary to the stored
// tally). Pure functions, no I/O.
import type { VotingSummary } from './client.js';

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

// NOTE: committee_yes_pct / committee_no_pct are also known to be wrong for a set
// of actions (Koios' summary double-counts a duplicate committee hot-key
// registration and keeps a resigned member in the denominator; /proposal_votes is
// ledger-exact). That correction is NOT yet implemented: ccYesPct in tallySync.ts
// is still taken straight from Koios. When it lands, it belongs here alongside the
// SPO recompute, so every Koios tally correction stays in one place.
