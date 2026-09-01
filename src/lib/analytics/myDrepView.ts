// Pure view models for the delegator-gated "My DRep" page: the since-delegation
// summary of one DRep's record (M1) and the effect a standing default option had
// on the last decided actions (M2). No I/O, everything here is deterministic.
import { formatAdaCompact } from '../format/ada.js';
import { isoDate } from '../format/date.js';
import { readableType, statusBadge } from '../governance/view.js';
import type { PowerPoint, RecentDecidedAction, SinceActionRow } from '../db/myDrep.js';

export interface MyDrepView {
  sinceEpoch: number;
  /** Calendar date of the start-epoch boundary, e.g. "2026-01-15". */
  sinceDateIso: string;
  eligible: number;
  voted: number;
  /** The eligible actions with no vote from this DRep, newest first. */
  missed: SinceActionRow[];
  /** Null when nothing was decided in the window, never a 0 percent. */
  participationPct: number | null;
  withRationale: number;
  /** Null when the DRep voted on nothing in the window. */
  rationalePct: number | null;
  voteChanges: number;
  power: {
    start: { epoch: number; label: string; firstOnRecord: boolean } | null;
    now: { epoch: number; label: string } | null;
    /**
     * True when both columns read the same snapshot row, either because only one
     * snapshot is on record or because the start epoch is the current one. There
     * is no change to state in that case, so every delta below stays null.
     */
    sameEpoch: boolean;
    deltaLabel: string | null;
  };
  delegators: { start: number | null; now: number | null; delta: number | null };
}

export interface MyDrepInput {
  sinceEpoch: number;
  /** Unix MILLISECONDS of the start-epoch boundary, from epochStartMs. */
  sinceStartMs: number;
  actions: SinceActionRow[];
  voteChanges: number;
  powerThen: PowerPoint | null;
  powerNow: PowerPoint | null;
}

/** Lovelace string to BigInt, or null when absent or non-numeric. */
function toLovelace(value: string): bigint | null {
  if (value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * The signed compact change between two power snapshots, e.g. "+500K ₳" or
 * "-250K ₳", with an unchanged power reading "0 ₳" rather than disappearing.
 * formatTrendDelta is deliberately not reused: it drops the sign (the directory
 * chip carries it in an arrow and a color, which this stats row has not) and
 * returns null on a flat delta, which here would hide a real answer.
 */
function powerDeltaLabel(then: PowerPoint | null, now: PowerPoint | null): string | null {
  if (!then || !now) return null;
  const a = toLovelace(then.amount);
  const b = toLovelace(now.amount);
  if (a == null || b == null) return null;
  const delta = b - a;
  const label = formatAdaCompact(delta < 0n ? (-delta).toString() : delta.toString());
  if (label == null) return null;
  if (delta === 0n) return label;
  return `${delta > 0n ? '+' : '-'}${label}`;
}

/** A snapshot's compact ada label, or null when the stored amount is unusable. */
function powerLabel(point: PowerPoint | null): string | null {
  return point ? formatAdaCompact(point.amount) : null;
}

/**
 * The since-delegation summary. Every figure states the same basis: the decided
 * actions the DRep was eligible for from `sinceEpoch` on, as read by
 * listDrepActionsSince. Percentages stay unrounded so the page decides the
 * precision, and both are null on an empty basis rather than a misleading 0.
 * A power snapshot whose amount cannot be read drops out entirely instead of
 * rendering as zero ada, and its delegator count (a separate column) survives.
 * When both reads return the same snapshot row, no change exists to state, so
 * the deltas are null rather than a zero that would read as "nothing moved".
 */
export function buildMyDrep(input: MyDrepInput): MyDrepView {
  const { sinceEpoch, sinceStartMs, actions, voteChanges, powerThen, powerNow } = input;

  const eligible = actions.length;
  const voted = actions.filter((a) => a.vote != null).length;
  const missed = actions.filter((a) => a.vote == null);
  // A rationale row can outlive the vote it belonged to (a self-cast that never
  // confirmed), so coverage counts only actions this DRep actually voted on.
  const withRationale = actions.filter((a) => a.vote != null && a.hasRationale).length;

  const thenLabel = powerLabel(powerThen);
  const nowLabel = powerLabel(powerNow);
  const thenCount = powerThen?.delegatorCount ?? null;
  const nowCount = powerNow?.delegatorCount ?? null;
  // One snapshot on record, or a delegation that started in the current epoch:
  // both columns then describe the same moment and a change cannot be computed.
  const sameEpoch = powerThen != null && powerNow != null && powerThen.epoch === powerNow.epoch;

  return {
    sinceEpoch,
    sinceDateIso: isoDate(new Date(sinceStartMs)),
    eligible,
    voted,
    missed,
    participationPct: eligible > 0 ? (voted / eligible) * 100 : null,
    withRationale,
    rationalePct: voted > 0 ? (withRationale / voted) * 100 : null,
    voteChanges,
    power: {
      start:
        powerThen && thenLabel != null
          ? { epoch: powerThen.epoch, label: thenLabel, firstOnRecord: powerThen.epoch > sinceEpoch }
          : null,
      now: powerNow && nowLabel != null ? { epoch: powerNow.epoch, label: nowLabel } : null,
      sameEpoch,
      deltaLabel:
        !sameEpoch && thenLabel != null && nowLabel != null ? powerDeltaLabel(powerThen, powerNow) : null,
    },
    delegators: {
      start: thenCount,
      now: nowCount,
      delta: !sameEpoch && thenCount != null && nowCount != null ? nowCount - thenCount : null,
    },
  };
}

export type DefaultOption = 'abstain' | 'no_confidence';

export interface DefaultOptionRow {
  gaId: string;
  title: string;
  /** Forum thread link, null for an action with no topic. */
  href: string | null;
  type: string;
  /** The action's outcome label, e.g. "Enacted". */
  outcome: string;
  effect: string;
}

export interface DefaultOptionView {
  /** The ledger rule, stated once above the list. */
  rule: string;
  rows: DefaultOptionRow[];
}

const RULE: Record<DefaultOption, string> = {
  abstain:
    'An always-abstain delegation is counted as abstaining on every governance action, so your stake stays out of the yes and no sides and out of the threshold.',
  no_confidence:
    'An always-no-confidence delegation is counted as yes on a no-confidence action and as no on every other type.',
};

/**
 * What a standing default option did to the delegator's stake on one action.
 * Always-abstain leaves the denominator on every type. Always-no-confidence is
 * counted as Yes on a NoConfidence action, because that action IS the motion the
 * option stands for, and as No on every other type.
 */
export function defaultOptionEffect(option: DefaultOption, type: string): string {
  if (option === 'abstain') return 'Your stake was left out of the threshold on this action';
  return type === 'NoConfidence' ? 'Your stake counted as Yes' : 'Your stake counted as No';
}

/**
 * The M2 list: the rule once, then the decided actions with the outcome and what
 * the option meant on each. An action with no title falls back to its readable
 * type, and one with no forum topic gets no link rather than a dead one.
 */
export function buildDefaultOptionView(
  option: DefaultOption,
  actions: RecentDecidedAction[],
): DefaultOptionView {
  return {
    rule: RULE[option],
    rows: actions.map((a) => ({
      gaId: a.gaId,
      title: a.title ?? readableType(a.type),
      href: a.topicSlug != null ? `/t/${a.topicSlug}/` : null,
      type: a.type,
      outcome: statusBadge(a.status).label,
      effect: defaultOptionEffect(option, a.type),
    })),
  };
}
