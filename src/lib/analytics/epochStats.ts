// Pure math for one governance_epoch_stats row. No DB and no env access, so
// both the live phase and the backfill share the exact same computation. The
// metric definitions live in epochStatsContract.ts, this file implements them.
//
// Honesty invariants: delegator_total is NULL unless EVERY snapshot row
// carries an observation (a partial sum must never masquerade as a total),
// and a duplicate snapshot row for one DRep is a contract violation that
// throws instead of silently double counting.
import { computeConcentration } from '../dreps/concentration.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';

export interface EpochHistoryInput {
  drepId: string;
  /** Lovelace snapshot amount for the epoch, as delivered by Koios. */
  amount: string;
  /** Stamped live observation, null when never observed (all backfill rows). */
  delegatorCount?: number | null;
}

export interface EpochStatsInput {
  epoch: number;
  /** Every history row of the epoch, specials included, this module splits them. */
  history: EpochHistoryInput[];
  recentlyVotingDrepCount: number;
  votesCast: number;
  voteDataComplete: boolean;
  treasuryLovelace: string | null;
}

export interface EpochStatsRow {
  epoch: number;
  totalDrepPower: string;
  poweredDrepCount: number;
  recentlyVotingDrepCount: number;
  abstainPower: string | null;
  ancPower: string | null;
  delegatorTotal: number | null;
  abstainDelegators: number | null;
  ancDelegators: number | null;
  gini: number;
  top10SharePct: number;
  minCoalition50: number;
  minCoalition67: number;
  votesCast: number;
  voteDataComplete: boolean;
  treasuryLovelace: string | null;
}

const [ABSTAIN_ID, ANC_ID] = SPECIAL_DREP_IDS;

/**
 * Gini coefficient over the positive amounts (a distribution statement about
 * DReps that hold power, zero-power registrations are not part of it). Sorted
 * closed form G = (2 * sum(i * x_i)) / (n * sum(x)) - (n + 1) / n with 1-based
 * ranks, BigInt throughout, scaled to a float at the end.
 */
export function computeGini(amounts: bigint[]): number {
  const xs = amounts.filter((a) => a > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = xs.length;
  if (n === 0) return 0;
  let total = 0n;
  let weighted = 0n;
  for (let i = 0; i < n; i++) {
    total += xs[i];
    weighted += BigInt(i + 1) * xs[i];
  }
  if (total === 0n) return 0;
  const scaled = (weighted * 2_000_000n) / (BigInt(n) * total);
  return Number(scaled) / 1_000_000 - (n + 1) / n;
}

/** Four-decimal percent of part out of total, BigInt-safe, 0 when total is 0. */
function pct4(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 1_000_000n) / total) / 10_000;
}

export function computeEpochStatsRow(input: EpochStatsInput): EpochStatsRow {
  const seen = new Set<string>();
  const specials = new Map<string, EpochHistoryInput>();
  const regular: EpochHistoryInput[] = [];
  for (const row of input.history) {
    if (seen.has(row.drepId)) {
      throw new Error(`duplicate snapshot row for ${row.drepId} in epoch ${input.epoch}`);
    }
    seen.add(row.drepId);
    if ((SPECIAL_DREP_IDS as readonly string[]).includes(row.drepId)) specials.set(row.drepId, row);
    else regular.push(row);
  }

  const powers = regular.map((r) => BigInt(r.amount));
  const clamped = powers.map((p) => (p > 0n ? p : 0n));
  const totalPower = clamped.reduce((a, b) => a + b, 0n);
  const top10 = [...clamped]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, 10)
    .reduce((a, b) => a + b, 0n);

  // computeConcentration supplies the coalition counts (its two-pointer walk),
  // the top-10 share above comes from the raw distribution instead of summing
  // its per-DRep percents, which are rounded to two decimals.
  const conc = computeConcentration(
    regular.map((r) => ({ drepId: r.drepId, name: null, power: BigInt(r.amount) })),
  );

  const counts = regular.map((r) => r.delegatorCount);
  const delegatorsComplete = regular.length > 0 && counts.every((c) => c != null);

  const abstain = specials.get(ABSTAIN_ID);
  const anc = specials.get(ANC_ID);

  return {
    epoch: input.epoch,
    totalDrepPower: totalPower.toString(),
    poweredDrepCount: clamped.filter((p) => p > 0n).length,
    recentlyVotingDrepCount: input.recentlyVotingDrepCount,
    abstainPower: abstain?.amount ?? null,
    ancPower: anc?.amount ?? null,
    delegatorTotal: delegatorsComplete ? (counts as number[]).reduce((a, b) => a + b, 0) : null,
    abstainDelegators: abstain?.delegatorCount ?? null,
    ancDelegators: anc?.delegatorCount ?? null,
    gini: computeGini(powers),
    top10SharePct: pct4(top10, totalPower),
    minCoalition50: conc.byPercent[50].count,
    minCoalition67: conc.byPercent[67].count,
    votesCast: input.votesCast,
    voteDataComplete: input.voteDataComplete,
    treasuryLovelace: input.treasuryLovelace,
  };
}
