// Whether a Not-met vote can still reach its threshold, and the fewest DReps whose
// switch to Yes would get it there. Pure, BigInt only, no I/O.
//
// Ratification is yes / (yes + no side) >= t, with abstain outside the tally. Every
// comparison runs on a fixed scale S = 1_000_000 with the threshold in the same scale
// (thrBp, four decimals as stored), so nothing is ever divided:
//
//   gapScaled = thrBp * C - Y * S          C = Y + N + Dv + Dx + F
//
// A switch to Yes from the no side (a No vote or a non-voter's default No) moves p
// from the no side into yes, so the denominator stays and the gap shrinks by p * S.
// A switch from Abstain adds p to both yes and the denominator, so it shrinks the
// gap by p * (S - thrBp). Since every switch reduces the same fixed gap by its own
// worth, taking candidates in descending worth reaches the gap with the fewest picks
// (any other set of k picks sums to at most the k largest worths).
import { round2 } from '../format/pct.js';
import type { BodyStakeView } from './fullStakeView.js';
import { committeeBelowMinSize } from './thresholds.js';

export type Tier = 'nonVoters' | 'abstainers' | 'noVoters' | 'fixed';

/**
 * Y yes, N voted No, Dv default No of DReps (or pools) who could still vote, Dx
 * default No nobody can move (inactive DReps), F fixed no side (always no
 * confidence, and always abstain where it counts as No for DReps), A abstain.
 */
export interface StakeBuckets {
  Y: bigint;
  N: bigint;
  Dv: bigint;
  Dx: bigint;
  F: bigint;
  A: bigint;
}

export interface StakeTier {
  tier: Tier;
  gapLovelace: bigint;
  gapScaled: bigint;
  thrBp: bigint;
}

export type Stance = 'notVoted' | 'No' | 'Abstain';

export interface PassCandidate {
  drepId: string;
  /** Profile slug, for the canonical profile link. */
  slug?: string | null;
  name: string | null;
  power: bigint;
  stance: Stance;
}

export interface FewestResult {
  picks: (PassCandidate & { worth: bigint })[];
  reaches: boolean;
}

export const SCALE = 1_000_000n;

export function thresholdBp(thresholdPct: number): bigint {
  return BigInt(Math.round(thresholdPct * 10_000));
}

export function drepBuckets(view: BodyStakeView, votableNonVoterSum: bigint): StakeBuckets {
  const a = view.amounts;
  const Dv = votableNonVoterSum < a.defaultNo ? votableNonVoterSum : a.defaultNo;
  return {
    Y: a.yes,
    N: a.no,
    Dv,
    Dx: a.defaultNo - Dv,
    F: a.alwaysNoConfidence + (view.aaCounted ? a.alwaysAbstain : 0n),
    A: a.activeAbstain,
  };
}

/**
 * Pool defaults (no vote, always no confidence, always abstain) only apply while a
 * pool has not voted, so a pool vote replaces them and nothing is fixed. Passive
 * always-abstain sits with A outside a hard fork and with Dv inside one.
 */
export function spoBuckets(view: BodyStakeView): StakeBuckets {
  const a = view.amounts;
  return {
    Y: a.yes,
    N: a.no,
    Dv: a.defaultNo + a.alwaysNoConfidence + (view.aaCounted ? a.alwaysAbstain : 0n),
    Dx: 0n,
    F: 0n,
    A: a.activeAbstain + (view.aaCounted ? 0n : a.alwaysAbstain),
  };
}

/** Null when nothing is counted or the threshold is already reached by exact arithmetic. */
export function reachTier(b: StakeBuckets, thresholdPct: number): StakeTier | null {
  const thrBp = thresholdBp(thresholdPct);
  const C = b.Y + b.N + b.Dv + b.Dx + b.F;
  if (C === 0n) return null;
  const gapScaled = thrBp * C - b.Y * SCALE;
  if (gapScaled <= 0n) return null;
  const gapLovelace = (gapScaled + SCALE - 1n) / SCALE;
  const viaNonVoters = b.Dv * SCALE;
  const viaAbstainers = viaNonVoters + b.A * (SCALE - thrBp);
  const viaNoVoters = viaAbstainers + b.N * SCALE;
  const tier: Tier =
    viaNonVoters >= gapScaled
      ? 'nonVoters'
      : viaAbstainers >= gapScaled
        ? 'abstainers'
        : viaNoVoters >= gapScaled
          ? 'noVoters'
          : 'fixed';
  return { tier, gapLovelace, gapScaled, thrBp };
}

function worthOf(c: PassCandidate, thrBp: bigint): bigint {
  return c.stance === 'Abstain' ? c.power * (SCALE - thrBp) : c.power * SCALE;
}

/**
 * Greedy minimum set reaching the gap. `reaches` caps the summed non-voter power at
 * dvCap (the tier's Dv), so a list never relies on default-No stake the tier left out.
 */
export function fewestToPass(
  cands: PassCandidate[],
  t: StakeTier,
  allowed: Stance[],
  dvCap: bigint,
): FewestResult {
  const sorted = cands
    .filter((c) => allowed.includes(c.stance))
    .map((c) => ({ ...c, worth: worthOf(c, t.thrBp) }))
    .sort((a, b) => (a.worth === b.worth ? (a.drepId < b.drepId ? -1 : 1) : a.worth > b.worth ? -1 : 1));
  const picks: FewestResult['picks'] = [];
  let sum = 0n;
  for (const c of sorted) {
    if (sum >= t.gapScaled) break;
    picks.push(c);
    sum += c.worth;
  }
  let notVoted = 0n;
  let other = 0n;
  for (const p of picks) {
    if (p.stance === 'notVoted') notVoted += p.power;
    else other += p.worth;
  }
  const capped = notVoted < dvCap ? notVoted : dvCap;
  return { picks, reaches: capped * SCALE + other >= t.gapScaled };
}

function within(sum: bigint, bucket: bigint): boolean {
  const diff = sum > bucket ? sum - bucket : bucket - sum;
  return diff * 1000n <= bucket;
}

/**
 * Whether the candidate rows describe the same snapshot as the tally buckets: the
 * No and Abstain sums within 0.1% of their buckets, the non-voters at most 0.1% above
 * the default No (part of it belongs to inactive DReps, so below is expected).
 */
export function reconcileCandidates(
  cands: PassCandidate[],
  view: BodyStakeView,
): { ok: boolean; notVotedSum: bigint } {
  let no = 0n;
  let abstain = 0n;
  let notVotedSum = 0n;
  for (const c of cands) {
    if (c.stance === 'No') no += c.power;
    else if (c.stance === 'Abstain') abstain += c.power;
    else notVotedSum += c.power;
  }
  const a = view.amounts;
  const ok =
    within(no, a.no) && within(abstain, a.activeAbstain) && notVotedSum <= a.defaultNo + a.defaultNo / 1000n;
  return { ok, notVotedSum };
}

export interface CcSeatTier {
  tier: Exclude<Tier, 'fixed'>;
  extraYes: number;
  notVoted: number;
}

/**
 * The badge rule: the two-decimal yes share ccTallyPct stores, against the
 * threshold in percent, so a seat line and the Met badge can never disagree.
 */
function ccMet(yes: number, denom: number, thresholdPct: number): boolean {
  return denom > 0 && round2((yes / denom) * 100) >= thresholdPct;
}

/**
 * The fewest extra Yes seats that meet the CC threshold, where a seat can come from
 * a member who has not voted (x), one who abstained (a, which also joins the
 * denominator) or one who voted No (n). The tier is the earliest group set, in the
 * order non-voters, abstainers, No voters, that reaches it with that minimum. `size`
 * is the committee at the action's boundary, never the live size.
 */
export function ccSeatsToPass(
  c: { yes: number; no: number; abstain: number; size: number },
  thresholdPct: number,
): CcSeatTier | null {
  const notVoted = c.size - c.yes - c.no - c.abstain;
  if (c.size - c.abstain <= 0 || notVoted < 0) return null;
  if (ccMet(c.yes, c.size - c.abstain, thresholdPct)) return null;
  // Only the abstainer count a moves the denominator. For a given a, the rest of the
  // k seats come from No voters first, the leftover x = k - a - n from non-voters.
  const reachable = (k: number, maxA: number, maxN: number): boolean => {
    for (let a = 0; a <= Math.min(k, maxA); a++) {
      const x = k - a - Math.min(k - a, maxN);
      if (x <= notVoted && ccMet(c.yes + k, c.size - c.abstain + a, thresholdPct)) return true;
    }
    return false;
  };
  for (let k = 1; k <= notVoted + c.abstain + c.no; k++) {
    if (!reachable(k, c.abstain, c.no)) continue;
    const tier = reachable(k, 0, 0) ? 'nonVoters' : reachable(k, c.abstain, 0) ? 'abstainers' : 'noVoters';
    return { tier, extraYes: k, notVoted };
  }
  return null;
}

/**
 * Whether the committee is below its minimum size at the action's boundary. For an
 * open action the stored flag was judged on the live size, which still counts a
 * member in their expiry epoch, so the boundary size is checked as well.
 */
export function ccBlockedAtBoundary(size: number | null, minSize: number | null, storedFlag: boolean | null): boolean {
  return storedFlag === true || committeeBelowMinSize(size, minSize) === true;
}
