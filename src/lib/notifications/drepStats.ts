// Pure logic for the DRep stats epoch digest: trigger evaluation, the payload
// shape carried on the notification row, and the shared one-line summary used
// by both the inbox row and the push lead. No DB, no I/O, unit-testable in
// node. Thresholds exist because staking rewards drift every DRep's voting
// power a little each epoch and large DReps see constant small delegator
// churn, so "any change" would fire for everyone every epoch.

import { formatAdaCompact } from '../format/ada.js';
import { pctIsMeaningful } from '../dreps/votingPowerTrend.js';

/** Fire when the epoch-over-epoch voting power moved at least this percent. */
export const POWER_TRIGGER_PCT = 1;
/** Fire when the delegator count moved at least this percent of the previous count. */
export const COUNT_TRIGGER_PCT = 1;
/** But never require less movement than this many delegators (small DReps). */
export const COUNT_TRIGGER_FLOOR = 1;

export interface DrepStatsCandidate {
  /** Lovelace amount for the current epoch, null when the snapshot is missing. */
  power: string | null;
  /** Lovelace amount for the previous epoch. */
  powerPrev: string | null;
  /** Delegator count stamped for the current epoch. */
  delegators: number | null;
  /** Delegator count stamped for the previous epoch. */
  delegatorsPrev: number | null;
}

export interface DrepStatsEvaluation {
  fires: boolean;
  /** Signed percent, null when the power part was skipped or prev was zero. */
  powerDeltaPct: number | null;
  /** Signed delegator delta, null when the count part was skipped. */
  countDelta: number | null;
}

/**
 * Decides whether an epoch digest fires for one DRep. Each part is skipped
 * (never fires, delta null) when its inputs are incomplete, so the first epoch
 * after ship (no stamped previous count) can only fire on power, and a
 * brand-new DRep (no previous snapshot at all) fires on neither.
 */
export function evaluateDrepStats(c: DrepStatsCandidate): DrepStatsEvaluation {
  let powerFires = false;
  let powerDeltaPct: number | null = null;
  const power = toNumber(c.power);
  const prev = toNumber(c.powerPrev);
  if (power !== null && prev !== null) {
    if (prev === 0) {
      // Power appeared out of nothing: always noteworthy, no percentage exists.
      powerFires = power > 0;
    } else {
      powerDeltaPct = ((power - prev) / prev) * 100;
      powerFires = Math.abs(powerDeltaPct) >= POWER_TRIGGER_PCT;
    }
  }

  let countFires = false;
  let countDelta: number | null = null;
  if (typeof c.delegators === 'number' && typeof c.delegatorsPrev === 'number') {
    countDelta = c.delegators - c.delegatorsPrev;
    const needed = Math.max(
      COUNT_TRIGGER_FLOOR,
      Math.ceil((c.delegatorsPrev * COUNT_TRIGGER_PCT) / 100),
    );
    countFires = Math.abs(countDelta) >= needed;
  }

  return { fires: powerFires || countFires, powerDeltaPct, countDelta };
}

/** The self-contained payload stored on a drep_stats notification row. */
export interface DrepStatsPayload {
  epoch: number;
  drepId: string;
  power: string | null;
  powerPrev: string | null;
  delegators: number | null;
  delegatorsPrev: number | null;
}

/**
 * Parses a drep_stats notification payload, returning null for anything
 * malformed. Never throws, so a bad row is dropped rather than crashing the
 * inbox render (mirrors parseDrepEventPayload). Strict on shape: a present
 * optional field of the wrong type rejects the whole payload instead of being
 * silently coerced to null, so a corrupted row cannot render half-true stats.
 */
export function parseDrepStatsPayload(payload: string | null): DrepStatsPayload | null {
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (!isNonNegativeInt(p.epoch) || typeof p.drepId !== 'string' || p.drepId === '') return null;
  const power = readPower(p.power);
  const powerPrev = readPower(p.powerPrev);
  const delegators = readCount(p.delegators);
  const delegatorsPrev = readCount(p.delegatorsPrev);
  if (
    power === undefined ||
    powerPrev === undefined ||
    delegators === undefined ||
    delegatorsPrev === undefined
  ) {
    return null;
  }
  return { epoch: p.epoch, drepId: p.drepId, power, powerPrev, delegators, delegatorsPrev };
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Absent stays null, a whole-lovelace decimal string passes, anything else rejects. */
function readPower(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && /^\d+$/.test(v) ? v : undefined;
}

/** Absent stays null, a non-negative integer passes, anything else rejects. */
function readCount(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  return isNonNegativeInt(v) ? v : undefined;
}

/**
 * The stat changes without the epoch prefix, e.g.
 * "voting power 65.2M ₳ (+3.2%), 1,540 delegators (+12)". Parts whose data is
 * absent are omitted, deltas that cannot be computed are left off rather than
 * guessed. Used as the push body, where the epoch rides in the title instead.
 */
export function formatDrepStatsDetail(p: DrepStatsPayload): string {
  const ev = evaluateDrepStats(p);
  const parts: string[] = [];
  const power = formatAdaCompact(p.power);
  if (power !== null) {
    let delta = '';
    if (ev.powerDeltaPct === null) {
      // "new" only when power actually appeared: zero staying zero (the count
      // part triggered the digest) is not new.
      const cur = toNumber(p.power);
      if (toNumber(p.powerPrev) === 0 && cur !== null && cur > 0) delta = ' (new)';
    } else if (pctIsMeaningful(ev.powerDeltaPct)) {
      // Signed here, unlike the site's chips, because a sentence carries no arrow.
      delta = ` (${ev.powerDeltaPct >= 0 ? '+' : ''}${ev.powerDeltaPct.toFixed(1)}%)`;
    } else {
      // Growth off a near-empty baseline: a five-digit percent tells the DRep
      // nothing, so name where they came from instead. Only gains land here, a
      // loss cannot pass -100%. The current amount already leads the line.
      const from = formatAdaCompact(p.powerPrev);
      if (from !== null) delta = ` (up from ${from})`;
    }
    parts.push(`voting power ${power}${delta}`);
  }
  if (typeof p.delegators === 'number') {
    const d = ev.countDelta;
    const delta = d === null || d === 0 ? '' : ` (${d > 0 ? '+' : ''}${d})`;
    const noun = p.delegators === 1 ? 'delegator' : 'delegators';
    parts.push(`${p.delegators.toLocaleString('en-US')} ${noun}${delta}`);
  }
  return parts.join(', ');
}

/**
 * One line for the inbox row, e.g.
 * "Epoch 570: voting power 65.2M ₳ (+3.2%), 1,540 delegators (+12)": the epoch
 * prefix plus {@link formatDrepStatsDetail}.
 */
export function formatDrepStatsSummary(p: DrepStatsPayload): string {
  return `Epoch ${p.epoch}: ${formatDrepStatsDetail(p)}`;
}

function toNumber(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
