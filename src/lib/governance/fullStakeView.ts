// Pure per-body stake view model. One body's vote turned into the two figures the
// sidebar needs and can never mix up:
//
//   counted = activeYes + noSide            the ratification denominator
//   total   = counted + activeAbstain + alwaysAbstain    every eligible lovelace
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
// marker sit at a meaningful position on the full-stake axis.
const SEGMENT_ORDER: FullStakeSegmentKey[] = [
  'yes',
  'no',
  'defaultNo',
  'alwaysNoConfidence',
  'activeAbstain',
  'alwaysAbstain',
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

/**
 * Four-decimal percent of part out of total, BigInt-safe, 0 when total is 0.
 * Same pattern as pct4 in lib/analytics/epochStats.ts, reimplemented locally
 * since that module is not a shared export surface for view code.
 */
function pct4(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 1_000_000n) / total) / 10_000;
}

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

  // What is left of the No side once the two identifiable parts come off is the
  // stake that never voted and carries the default No. Clamped: a Koios snapshot
  // taken mid-update can report a No side smaller than its own parts.
  const defaultNoRaw = noSide - activeNo - alwaysNoConfidence;
  const defaultNo = defaultNoRaw > 0n ? defaultNoRaw : 0n;

  const counted = activeYes + noSide;
  const excluded = activeAbstain + alwaysAbstain;
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

  const segments: FullStakeSegment[] = SEGMENT_ORDER.filter((key) => amounts[key] > 0n).map((key) => ({
    key,
    pct: pct4(amounts[key], total),
    label: LABELS[key],
    amountLabel: ada(amounts[key]),
    counted: COUNTED[key],
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
