// Pure full-stake tally view model. Renders the composition bar against the
// FULL representative denominator (the epoch's total_drep_power plus both
// default-vote pools), not just the active-vote total. Progressive
// enhancement: returns null until every piece required for an honest
// full-stake bar is present, so callers fall back to the existing
// active-only bar. No I/O, deterministic, unit-tested.
import { formatAda } from '../forum/view.js';

export type FullStakeSegmentKey =
  | 'yes'
  | 'no'
  | 'activeAbstain'
  | 'alwaysAbstain'
  | 'alwaysNoConfidence'
  | 'notVoted';

export interface FullStakeSegment {
  key: FullStakeSegmentKey;
  pct: number;
  label: string;
  amountLabel: string;
}

export interface FullStakeBarView {
  /** Only segments with a positive amount, in the bar order below. */
  segments: FullStakeSegment[];
  /** formatAda of the full denominator. */
  totalLabel: string;
  /** What always-no-confidence counts toward on this action type. */
  ancEffect: 'yes' | 'no';
  /** Threshold position mapped onto the full-stake axis, null without a threshold. */
  thresholdPct: number | null;
}

export interface FullStakeBarInput {
  actionType: string;
  /** The stored INTEGER columns, safe under 2^53. */
  activeYesPower: number | null;
  activeNoPower: number | null;
  activeAbstainPower: number | null;
  /** The new TEXT columns, raw lovelace strings. */
  alwaysAbstainPower: string | null;
  alwaysNoConfidencePower: string | null;
  /** governance_epoch_stats.total_drep_power at the action's epoch. */
  reprTotalPower: string | null;
  /** The body's ratification threshold in percent, e.g. 67. */
  approvalThresholdPct: number | null;
}

const SEGMENT_ORDER: FullStakeSegmentKey[] = [
  'yes',
  'no',
  'activeAbstain',
  'alwaysAbstain',
  'alwaysNoConfidence',
  'notVoted',
];

const LABELS: Record<FullStakeSegmentKey, string> = {
  yes: 'Yes',
  no: 'No',
  activeAbstain: 'Abstain (active)',
  alwaysAbstain: 'Always abstain',
  alwaysNoConfidence: 'Always no confidence',
  notVoted: 'Not voted',
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

export function buildFullStakeBar(input: FullStakeBarInput): FullStakeBarView | null {
  const hasActivePower =
    input.activeYesPower !== null || input.activeNoPower !== null || input.activeAbstainPower !== null;
  if (
    input.alwaysAbstainPower === null ||
    input.alwaysNoConfidencePower === null ||
    input.reprTotalPower === null ||
    !hasActivePower
  ) {
    return null;
  }

  const reprTotal = BigInt(input.reprTotalPower);
  const alwaysAbstain = BigInt(input.alwaysAbstainPower);
  const alwaysNoConfidence = BigInt(input.alwaysNoConfidencePower);
  const activeYes = activePower(input.activeYesPower);
  const activeNo = activePower(input.activeNoPower);
  const activeAbstain = activePower(input.activeAbstainPower);

  const denominator = reprTotal + alwaysAbstain + alwaysNoConfidence;
  const notVotedRaw = reprTotal - activeYes - activeNo - activeAbstain;
  const notVoted = notVotedRaw > 0n ? notVotedRaw : 0n;

  const amounts: Record<FullStakeSegmentKey, bigint> = {
    yes: activeYes,
    no: activeNo,
    activeAbstain,
    alwaysAbstain,
    alwaysNoConfidence,
    notVoted,
  };

  const segments: FullStakeSegment[] = SEGMENT_ORDER.filter((key) => amounts[key] > 0n).map((key) => ({
    key,
    pct: pct4(amounts[key], denominator),
    label: LABELS[key],
    amountLabel: formatAda(amounts[key].toString()),
  }));

  // The threshold applies to yes over (reprTotal minus activeAbstain). Reuse
  // pct4 for that ratio (BigInt-safe at any magnitude), then scale by the
  // threshold percent, a small bounded number so the final multiplication is
  // safe in plain floating point.
  const yesEligible = reprTotal - activeAbstain;
  const yesEligiblePct = pct4(yesEligible, denominator);
  const thresholdPct =
    input.approvalThresholdPct === null
      ? null
      : Math.min(100, Math.max(0, (input.approvalThresholdPct * yesEligiblePct) / 100));

  return {
    segments,
    totalLabel: formatAda(denominator.toString()),
    ancEffect: input.actionType === 'NoConfidence' ? 'yes' : 'no',
    thresholdPct,
  };
}
