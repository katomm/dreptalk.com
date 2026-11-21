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
import { pct4 } from '../format/pct.js';

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
  /** Distinct non-special DReps with a vote in the trailing window ending at this epoch. */
  recentlyVotingDrepIds: ReadonlySet<string>;
  votesCast: number;
  voteDataComplete: boolean;
  treasuryLovelace: string | null;
  /**
   * The group behind the DRep list's header numbers as the dreps phase of
   * this run observed it: registered DReps whose activity has not expired,
   * specials excluded (the rows of listDrepsForConcentration). Null when this
   * run has no fresh observation, which stores NULL instead of a stale or
   * guessed value.
   */
  unexpiredDreps: readonly UnexpiredDrepInput[] | null;
}

export interface UnexpiredDrepInput {
  /** Lovelace, null when Koios served no amount (counts as zero power). */
  votingPower: string | null;
}

export interface EpochStatsRow {
  epoch: number;
  totalDrepPower: string;
  poweredDrepCount: number;
  recentlyVotingDrepCount: number;
  /** Powered DReps without a vote in the window, null on stored rows the repair pass has not read yet. */
  silentPoweredDrepCount: number | null;
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
  /** Unexpired DReps at the last DRep sync of the epoch, zero power included. Null without an observation. */
  unexpiredDrepCount: number | null;
  /** The subset of unexpiredDrepCount holding voting power above zero. */
  unexpiredPoweredDrepCount: number | null;
  /** Summed voting power (lovelace) of the unexpired DReps. */
  unexpiredDrepPower: string | null;
  /** Share of unexpiredDrepPower held by its ten largest DReps. */
  unexpiredTop10SharePct: number | null;
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
  // BigInt division truncates, so an equal distribution can compute a tiny
  // negative (for example about -3.3e-7 at n=3) instead of exactly 0. Clamp,
  // a coefficient below 0 is never a real answer.
  return Math.max(0, Number(scaled) / 1_000_000 - (n + 1) / n);
}

/**
 * DReps holding power in the snapshot with no vote in the recently-voting
 * window. Read against the epoch's own power holders, so a voter that has
 * since lost its power or retired counts as recently voting but never as
 * silent. Specials are excluded, they never vote.
 */
export function countSilentPoweredDreps(history: EpochHistoryInput[], voters: ReadonlySet<string>): number {
  let silent = 0;
  for (const r of history) {
    if ((SPECIAL_DREP_IDS as readonly string[]).includes(r.drepId) || voters.has(r.drepId)) continue;
    if (BigInt(r.amount) > 0n) silent += 1;
  }
  return silent;
}

const desc = (a: bigint, b: bigint) => (a < b ? 1 : a > b ? -1 : 0);

/** Sum of the ten largest amounts. */
function top10Sum(amounts: bigint[]): bigint {
  return [...amounts].sort(desc).slice(0, 10).reduce((a, b) => a + b, 0n);
}

/**
 * Lenient lovelace parse for the dreps.voting_power column: NULL, anything
 * that is no integer string and negative amounts all count as zero. The list
 * header parses the same column the same way, and a throw here would discard
 * the whole epoch row, not just these columns.
 */
function positiveLovelace(s: string | null): bigint {
  try {
    const p = BigInt(s ?? '0');
    return p > 0n ? p : 0n;
  } catch {
    return 0n;
  }
}

type UnexpiredStats = Pick<
  EpochStatsRow,
  'unexpiredDrepCount' | 'unexpiredPoweredDrepCount' | 'unexpiredDrepPower' | 'unexpiredTop10SharePct'
>;

/**
 * Aggregates over the observed unexpired group. BigInt throughout, lovelace
 * sums exceed Number's exact range. A DRep without power still counts as
 * unexpired, the powered count is the subset above zero.
 */
function summarizeUnexpiredDreps(dreps: readonly UnexpiredDrepInput[] | null): UnexpiredStats {
  if (dreps === null) {
    return {
      unexpiredDrepCount: null,
      unexpiredPoweredDrepCount: null,
      unexpiredDrepPower: null,
      unexpiredTop10SharePct: null,
    };
  }
  const powers = dreps.map((d) => positiveLovelace(d.votingPower));
  const total = powers.reduce((a, b) => a + b, 0n);
  return {
    unexpiredDrepCount: dreps.length,
    unexpiredPoweredDrepCount: powers.filter((p) => p > 0n).length,
    unexpiredDrepPower: total.toString(),
    unexpiredTop10SharePct: pct4(top10Sum(powers), total),
  };
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
  const top10 = top10Sum(clamped);

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
    recentlyVotingDrepCount: input.recentlyVotingDrepIds.size,
    silentPoweredDrepCount: countSilentPoweredDreps(regular, input.recentlyVotingDrepIds),
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
    ...summarizeUnexpiredDreps(input.unexpiredDreps),
  };
}
