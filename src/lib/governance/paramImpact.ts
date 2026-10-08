// What a staking parameter change does, computed from the pool distribution
// of one epoch. A model, and the panel copy says which simplifications it
// makes: full block production (eta = 1), no fees, rewards that are not paid
// out are ignored. All amounts in ada. Leaf module, no network, no DOM.
import { rationalToNumber } from '../format/rational.js';
import type { ParamValues } from './paramDefs.js';

export interface PoolEconomicsJson {
  epoch: number;
  supplyLovelace: string;
  reservesLovelace: string;
  /** [active stake in ada, pledge in ada, fixed cost in lovelace], sorted by stake, largest first. */
  pools: [number, number, string][];
}

export interface PoolEconomics {
  epoch: number;
  /** The reward formula's total stake: max supply minus reserves (Koios supply). */
  totalStakeAda: number;
  reservesAda: number;
  pools: { stake: number; pledge: number; costLovelace: bigint }[];
}

/** The parameters the reward model reads. Two or more of them picked share one combined rewards chart. */
export const REWARD_KEYS = ['k', 'a0', 'rho', 'tau'] as const;

export interface ModelParams {
  k: number;
  a0: number;
  rho: number;
  tau: number;
}

/** Lovelace string to ada, keeping the fraction (the model works in floats, the fraction matters for the anchors). */
const lovelaceToAda = (lovelace: string): number => {
  const v = BigInt(lovelace);
  return Number(v / 1_000_000n) + Number(v % 1_000_000n) / 1_000_000;
};

export function economicsFromJson(json: PoolEconomicsJson): PoolEconomics {
  return {
    epoch: json.epoch,
    totalStakeAda: lovelaceToAda(json.supplyLovelace),
    reservesAda: lovelaceToAda(json.reservesLovelace),
    pools: json.pools.map(([stake, pledge, cost]) => ({ stake, pledge, costLovelace: BigInt(cost) })),
  };
}

/** The model inputs before and after: the package's value where it has one, the current value otherwise. */
export function modelParams(current: ParamValues, next: ParamValues): { from: ModelParams; to: ModelParams } | null {
  const pick = (key: 'k' | 'a0' | 'rho' | 'tau', source: ParamValues) => {
    const v = source[key] ?? current[key];
    return v ? rationalToNumber(v) : null;
  };
  const from = { k: pick('k', current), a0: pick('a0', current), rho: pick('rho', current), tau: pick('tau', current) };
  const to = { k: pick('k', next), a0: pick('a0', next), rho: pick('rho', next), tau: pick('tau', next) };
  if (Object.values(from).some((v) => v === null) || Object.values(to).some((v) => v === null)) return null;
  return { from: from as ModelParams, to: to as ModelParams };
}

/** The ledger's maximum pool reward share (Shelley spec, maxPool), before multiplying by the pot. */
export function maxPool(stake: number, pledge: number, k: number, a0: number, totalStake: number): number {
  const z0 = 1 / k;
  const sigma = Math.min(stake / totalStake, z0);
  const s = Math.min(pledge / totalStake, z0);
  return (1 / (1 + a0)) * (sigma + (s * a0 * (sigma - (s * (z0 - sigma)) / z0)) / z0);
}

/** Reward pot per epoch at full block production, before fees. */
function pot(eco: PoolEconomics, p: ModelParams): number {
  return eco.reservesAda * p.rho * (1 - p.tau);
}

export function saturation(eco: PoolEconomics, kFrom: number, kTo: number) {
  const pointFrom = eco.totalStakeAda / kFrom;
  const pointTo = eco.totalStakeAda / kTo;
  let aboveFrom = 0;
  let aboveTo = 0;
  let excessFrom = 0;
  let excessTo = 0;
  for (const pool of eco.pools) {
    if (pool.stake > pointFrom) {
      aboveFrom++;
      excessFrom += pool.stake - pointFrom;
    }
    if (pool.stake > pointTo) {
      aboveTo++;
      excessTo += pool.stake - pointTo;
    }
  }
  return { pointFrom, pointTo, aboveFrom, aboveTo, excessFrom, excessTo };
}

/** Relative change of a pool's maximum rewards (0.01 is +1%), the pot included. */
export function rewardChange(eco: PoolEconomics, from: ModelParams, to: ModelParams, stake: number, pledge: number): number {
  const before = maxPool(stake, pledge, from.k, from.a0, eco.totalStakeAda) * pot(eco, from);
  const after = maxPool(stake, pledge, to.k, to.a0, eco.totalStakeAda) * pot(eco, to);
  return after / before - 1;
}

export const CURVE_PLEDGES = [1e6, 10e6, 30e6] as const;

/** Points along the stake axis of the rewards chart. */
const CURVE_STEPS = 120;

/**
 * One curve per pledge level over pool stake, on a range relative to the
 * network: from 2% of the new saturation point to 1.5 times the higher of the
 * two points. A curve starts at its pledge, a pledge beyond the range has no
 * curve. Both saturation points are sampled exactly, so the kink is sharp.
 */
export function rewardCurves(eco: PoolEconomics, from: ModelParams, to: ModelParams) {
  const { pointFrom, pointTo } = saturation(eco, from.k, to.k);
  const xMin = 0.02 * pointTo;
  const xMax = 1.5 * Math.max(pointFrom, pointTo);
  const grid: number[] = [];
  for (let i = 0; i <= CURVE_STEPS; i++) grid.push(xMin + ((xMax - xMin) * i) / CURVE_STEPS);
  grid.push(pointFrom, pointTo);
  const curves = CURVE_PLEDGES.filter((pledge) => pledge <= xMax).map((pledge) => {
    const start = Math.max(xMin, pledge);
    const stakes = [...new Set([start, ...grid.filter((stake) => stake > start)])].sort((a, b) => a - b);
    const points: [number, number][] = stakes.map((stake) => [stake, rewardChange(eco, from, to, stake, pledge)]);
    return { pledge, points };
  });
  return { xMin, xMax, pointFrom, pointTo, curves };
}

/**
 * Three reference pools relative to the new saturation point: half of it with
 * 1M ada pledge, the same pool with 30% of its stake as pledge, and a pool at
 * 90% of it with 30% pledge.
 */
export function samplePools(eco: PoolEconomics, kTo: number): { stake: number; pledge: number }[] {
  const point = eco.totalStakeAda / kTo;
  const half = 0.5 * point;
  const near = 0.9 * point;
  return [
    { stake: half, pledge: Math.min(1e6, half) },
    { stake: half, pledge: 0.3 * half },
    { stake: near, pledge: 0.3 * near },
  ];
}

/** Width of a fixed cost bin, and where the last, open-ended bin starts. */
export const BIN_ADA = 25;
export const BIN_MAX_ADA = 500;

export function minPoolCostImpact(eco: PoolEconomics, currentLovelace: bigint, nextLovelace: bigint) {
  const bins: { fromAda: number; toAda: number | null; count: number }[] = [];
  for (let from = 0; from < BIN_MAX_ADA; from += BIN_ADA) bins.push({ fromAda: from, toAda: from + BIN_ADA, count: 0 });
  bins.push({ fromAda: BIN_MAX_ADA, toAda: null, count: 0 });
  let below = 0;
  let atCurrent = 0;
  for (const pool of eco.pools) {
    if (pool.costLovelace < nextLovelace) below++;
    if (pool.costLovelace === currentLovelace) atCurrent++;
    const ada = Number(pool.costLovelace / 1_000_000n);
    const index = ada >= BIN_MAX_ADA ? bins.length - 1 : Math.floor(ada / BIN_ADA);
    bins[index].count++;
  }
  return { below, atCurrent, bins };
}

export function budget(eco: PoolEconomics, from: ModelParams, to: ModelParams) {
  const drawFrom = eco.reservesAda * from.rho;
  const drawTo = eco.reservesAda * to.rho;
  return {
    drawFrom,
    drawTo,
    treasuryFrom: drawFrom * from.tau,
    treasuryTo: drawTo * to.tau,
    stakersFrom: drawFrom * (1 - from.tau),
    stakersTo: drawTo * (1 - to.tau),
  };
}
