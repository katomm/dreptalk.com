// Pure per-body stake view model. One body's vote turned into the two figures the
// sidebar needs and can never mix up:
//
//   counted = activeYes + noSide            the ratification denominator
//   total   = counted + activeAbstain + alwaysAbstain    every eligible lovelace
//
// except for the SPO vote on a HardForkInitiation, where the always-abstain stake is
// already inside noSide (see alwaysAbstainIsNoSide) and total = counted + activeAbstain.
//
// The yes percentage is counted-based (it is what the threshold is measured
// against, and what gov.tools/adastats/Cardanoscan show), turnout is total-based.
// Reporting one against the other's denominator is the bug this module exists to
// prevent: an action can sit at 51% yes on 28% turnout without either number being
// wrong, because half the eligible stake is abstain that leaves the tally.
//
// noSide is Koios' drep_no_vote_power / pool_no_vote_power: cast No plus the
// non-voting default No plus always-no-confidence, in one figure. It must never be
// summed with the always-no-confidence bucket, which it already contains (see
// eligibleStake in koios/corrections.ts for the verification).
//
// Progressive enhancement: returns null until every piece required for an honest
// reading is present, so callers fall back to the pre-capture rendering. All
// arithmetic is BigInt, because the always-abstain bucket exceeds 2^53 lovelace.
// No I/O, deterministic, unit-tested.
//
// Amounts render compact ("5.27B ₳"): the sidebar is 300px wide and these are the
// largest numbers on the site. formatAdaCompact is BigInt-safe on the raw strings.
import { formatAdaCompact } from '../format/ada.js';
import { pct4 } from '../format/pct.js';

/** Compact ada for a raw lovelace amount, two decimals so 10.89B and 10.52B differ. */
function ada(lovelace: bigint): string {
  return formatAdaCompact(lovelace.toString(), 2) ?? '0 ₳';
}

export type FullStakeSegmentKey =
  | 'yes'
  | 'no'
  | 'defaultNo'
  | 'alwaysNoConfidence'
  | 'activeAbstain'
  | 'alwaysAbstain';

export interface FullStakeSegment {
  key: FullStakeSegmentKey;
  /** Share of the FULL eligible stake, four decimals. */
  pct: number;
  label: string;
  amountLabel: string;
  /** Whether this segment is inside the ratification denominator. */
  counted: boolean;
}

export interface BodyStakeView {
  /** Only segments with a positive amount, in the order below. */
  segments: FullStakeSegment[];
  /** Compact ada of the ratification denominator (activeYes + noSide). */
  countedLabel: string;
  /** Compact ada of every eligible lovelace. */
  totalLabel: string;
  /** Compact ada of the stake outside the tally (activeAbstain + alwaysAbstain). */
  excludedLabel: string;
  /** Share of the FULL stake that is counted, four decimals. Positions the marker. */
  countedSharePct: number;
  /** Cast share of the FULL stake (yes + no + abstain actually voted), four decimals. */
  turnoutPct: number;
  /** The body's ratification threshold in percent, e.g. 67. Null without one. */
  approvalThresholdPct: number | null;
}

export interface BodyStakeInput {
  actionType: string;
  body: 'DRep' | 'SPO';
  /** The stored INTEGER power columns, safe under 2^53. */
  activeYesPower: number | null;
  activeNoPower: number | null;
  activeAbstainPower: number | null;
  /** The stored TEXT columns, raw lovelace strings. */
  noSidePower: string | null;
  alwaysAbstainPower: string | null;
  alwaysNoConfidencePower: string | null;
  /** The body's ratification threshold in percent, e.g. 67. */
  approvalThresholdPct: number | null;
}

// Ordered so the bar reads yes side, then no side, then the excluded tail: the
// counted stake stays contiguous from the left, which is what lets the threshold
// marker sit at a meaningful position on the full-stake axis. When always-abstain is
// counted (alwaysAbstainIsNoSide), it moves ahead of the voted abstain for the same reason.
const SEGMENT_ORDER: FullStakeSegmentKey[] = [
  'yes',
  'no',
  'defaultNo',
  'alwaysNoConfidence',
  'activeAbstain',
  'alwaysAbstain',
];
const SEGMENT_ORDER_AA_COUNTED: FullStakeSegmentKey[] = [
  'yes',
  'no',
  'defaultNo',
  'alwaysNoConfidence',
  'alwaysAbstain',
  'activeAbstain',
];

const COUNTED: Record<FullStakeSegmentKey, boolean> = {
  yes: true,
  no: true,
  defaultNo: true,
  alwaysNoConfidence: true,
  activeAbstain: false,
  alwaysAbstain: false,
};

const LABELS: Record<FullStakeSegmentKey, string> = {
  yes: 'Yes',
  no: 'No, voted',
  defaultNo: 'No by default, did not vote',
  alwaysNoConfidence: 'Always no confidence',
  activeAbstain: 'Abstain, voted',
  alwaysAbstain: 'Always abstain',
};

/** Stored INTEGER power columns are optional, null reads as no vote of that kind. */
function activePower(v: number | null): bigint {
  return v === null ? 0n : BigInt(v);
}

/**
 * Whether the always-no-confidence bucket sits on the No side for this action type.
 * It does for every type that has ever reached mainnet. On a NoConfidence action the
 * ledger counts it as Yes instead, and no NoConfidence action has ever been submitted
 * on mainnet, so which side Koios then reports it on is unverified. Rather than guess
 * a breakdown from an untested assumption, buildBodyStake declines that one type and
 * the caller keeps the plain counted bar.
 */
export function ancIsNoSide(actionType: string): boolean {
  return actionType !== 'NoConfidence';
}

/**
 * Whether the always-abstain bucket is part of the No side instead of leaving the
 * tally. Only for the SPO vote on a HardForkInitiation: the ledger ignores the
 * reward-account default there and counts every pool that did not vote as No.
 *
 * Koios already folds that stake into pool_no_vote_power for hard forks, the same way
 * it folds in always-no-confidence, and still reports the bucket on its own. Verified
 * on both mainnet hard forks against the epoch's total active stake: van Rossem
 * (epoch 643) yes + no side + voted abstain is 21.40B of 21.41B active, Plomin
 * (epoch 536) 21.73B of 21.77B. Adding the always-abstain bucket on top would exceed
 * the stake that exists (25.41B, 21.98B), and van Rossem, ratified against a 51%
 * threshold, would read 44.05% yes. So here the bucket is a part of the No side and is
 * split out of it for display. For every other type and for DReps it sits outside the
 * No side and outside the tally.
 */
export function alwaysAbstainIsNoSide(actionType: string, body: 'DRep' | 'SPO'): boolean {
  return body === 'SPO' && actionType === 'HardForkInitiation';
}

/**
 * The yes share of the ratification denominator (yes + no side), four decimals,
 * computed from the stored power columns. Null when a column is missing, and for
 * NoConfidence, which the plain no side does not describe (see ancIsNoSide). The SPO
 * vote on a hard fork needs no exception: its no side already holds the
 * always-abstain stake the ledger counts as No (see alwaysAbstainIsNoSide).
 */
export function ratificationYesPct(input: RatificationInput): number | null {
  const parts = ratificationParts(input);
  return parts ? pct4(parts.yes, parts.counted) : null;
}

interface RatificationInput {
  actionType: string;
  body: 'DRep' | 'SPO';
  yesPower: number | string | null;
  noSidePower: string | null;
}

interface RatificationParts {
  yes: bigint;
  counted: bigint;
}

/** Yes and the ratification denominator in lovelace, null where ratificationYesPct declines. */
function ratificationParts(input: RatificationInput): RatificationParts | null {
  if (input.yesPower === null || input.noSidePower === null || !ancIsNoSide(input.actionType)) return null;
  let yes: bigint;
  let noSide: bigint;
  try {
    yes = BigInt(input.yesPower);
    noSide = BigInt(input.noSidePower);
  } catch {
    return null;
  }
  const counted = yes + noSide;
  return counted > 0n ? { yes, counted } : null;
}

/**
 * Whether the power columns belong to the same snapshot as the stored percentage:
 * the derived share rounds back to exactly the stored one. The stored pct is frozen
 * when the action is decided. The columns of an action decided before they existed
 * were backfilled later from Koios, which recomputes a closed action with the
 * delegations of the day it is asked, so they can describe a later ledger state.
 * When they reproduce the pct, the derived value only adds precision (a stored
 * 56.15 is really 56.149, so it reads 56.1 and not 56.2).
 *
 * The exact ratio is rounded half up to hundredths in BigInt, the way Koios rounds.
 * Rounding the truncated four-decimal share as a float would misjudge the boundary:
 * an exact 1.00501 truncates to 1.005, which Math.round turns into 1.00 against a
 * stored 1.01.
 */
export function bucketsReproduceTally(storedPct: number, parts: RatificationParts): boolean {
  const hundredths = ((parts.yes * 20_000n) / parts.counted + 1n) / 2n;
  return hundredths === BigInt(Math.round(storedPct * 100));
}

export interface BodyTallyInput {
  actionType: string;
  body: 'DRep' | 'SPO';
  storedPct: number | null;
  yesPower: number | string | null;
  noSidePower: string | null;
}

/**
 * True when a body's power columns contradict its stored percentage (see
 * bucketsReproduceTally). Readers then drop every amount of that body, so no
 * surface shows a percentage next to amounts that give a different one.
 */
export function bucketsDrifted(input: BodyTallyInput): boolean {
  const parts = ratificationParts(input);
  return input.storedPct != null && parts != null && !bucketsReproduceTally(input.storedPct, parts);
}

/**
 * The yes share to show for a body: the stored pct, refined to four decimals from
 * the power columns when they reproduce it. Null before a tally syncs.
 */
export function shownYesPct(input: BodyTallyInput): number | null {
  if (input.storedPct == null) return null;
  const parts = ratificationParts(input);
  return parts != null && bucketsReproduceTally(input.storedPct, parts)
    ? pct4(parts.yes, parts.counted)
    : input.storedPct;
}

export function buildBodyStake(input: BodyStakeInput): BodyStakeView | null {
  const hasActivePower =
    input.activeYesPower !== null || input.activeNoPower !== null || input.activeAbstainPower !== null;
  if (
    input.noSidePower === null ||
    input.alwaysAbstainPower === null ||
    input.alwaysNoConfidencePower === null ||
    !hasActivePower ||
    !ancIsNoSide(input.actionType)
  ) {
    return null;
  }

  // The TEXT columns are untrusted stored text, same rationale as toLovelace in
  // analytics.astro: parse defensively so a single malformed stored value cannot
  // 500 the governance action page, degrading to the plain counted bar instead.
  let noSide: bigint;
  let alwaysAbstain: bigint;
  let alwaysNoConfidence: bigint;
  try {
    noSide = BigInt(input.noSidePower);
    alwaysAbstain = BigInt(input.alwaysAbstainPower);
    alwaysNoConfidence = BigInt(input.alwaysNoConfidencePower);
  } catch {
    return null;
  }

  const activeYes = activePower(input.activeYesPower);
  const activeNo = activePower(input.activeNoPower);
  const activeAbstain = activePower(input.activeAbstainPower);

  const aaCounted = alwaysAbstainIsNoSide(input.actionType, input.body);

  // What is left of the No side once the identifiable parts come off is the stake
  // that never voted and carries the default No. A No side smaller than its own
  // parts (a Koios snapshot taken mid-update) has no honest split: the segments
  // would add up to more than the total, so the caller keeps the plain counted bar.
  const defaultNo = noSide - activeNo - alwaysNoConfidence - (aaCounted ? alwaysAbstain : 0n);
  if (defaultNo < 0n) return null;

  const counted = activeYes + noSide;
  const excluded = aaCounted ? activeAbstain : activeAbstain + alwaysAbstain;
  const total = counted + excluded;
  if (total <= 0n) return null;

  const amounts: Record<FullStakeSegmentKey, bigint> = {
    yes: activeYes,
    no: activeNo,
    defaultNo,
    alwaysNoConfidence,
    activeAbstain,
    alwaysAbstain,
  };

  const order = aaCounted ? SEGMENT_ORDER_AA_COUNTED : SEGMENT_ORDER;
  const segments: FullStakeSegment[] = order.filter((key) => amounts[key] > 0n).map((key) => ({
    key,
    pct: pct4(amounts[key], total),
    label: key === 'alwaysAbstain' && aaCounted ? 'Always abstain, counted as No' : LABELS[key],
    amountLabel: ada(amounts[key]),
    counted: key === 'alwaysAbstain' ? aaCounted : COUNTED[key],
  }));

  return {
    segments,
    countedLabel: ada(counted),
    totalLabel: ada(total),
    excludedLabel: ada(excluded),
    countedSharePct: pct4(counted, total),
    turnoutPct: pct4(activeYes + activeNo + activeAbstain, total),
    approvalThresholdPct: input.approvalThresholdPct,
  };
}
