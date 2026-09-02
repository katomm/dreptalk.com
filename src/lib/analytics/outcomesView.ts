// Pure view models for the analytics hub's SPO oversight snapshot and
// governance throughput cards. Both derive purely from DecidedOutcomeRow
// rows plus the frozen threshold snapshot each action carries, so the same
// inputs always produce the same numbers. Stake sums use BigInt end to end,
// spoAlwaysAbstainPower and spoNoSidePower arrive as TEXT and can exceed
// Number's safe-integer range. No I/O, deterministic, unit-tested.
import type { DecidedOutcomeRow, LineageActionRow } from '../db/hubOutcomes.js';
import { lineagePredecessor } from '../governance/onchain.js';
import { readThresholdSnapshot } from '../governance/thresholds.js';

export interface SpoSnapshot {
  /** Decided actions that carry an on-chain SPO threshold. */
  eligible: number;
  /** Median SPO turnout, over the eligible actions with a complete stake tally. */
  medianTurnoutPct: number | null;
  /** Eligible actions with a complete stake tally (used for the median). */
  turnoutBasis: number;
  /** Eligible actions excluded from the turnout median for a missing or unparseable stake field. */
  turnoutExcluded: number;
  /** Actions where the DRep and SPO verdicts differ. */
  divergent: number;
  /** Actions where both the DRep and SPO verdicts are known. */
  divergenceBasis: number;
  /** The divergent actions themselves, one entry per row counted in divergent. */
  divergentActions: DivergentAction[];
}

export interface DivergentAction {
  gaId: string;
  /** Null when the action has no title, so the caller can name it by its readable type. */
  title: string | null;
  href: string | null;
  type: string;
  /** The body whose tally fell below its own threshold. */
  missedBy: 'DRep' | 'SPO';
}

export interface ThroughputView {
  submittedRecent: number;
  windowEpochs: 12;
  enacted: number;
  expired: number;
  closed: number;
  dropped: number;
  active: number;
  /** Median epochs from submission to decision, over decided actions with a known submission epoch. */
  medianEpochsToDecision: number | null;
  decisionBasis: number;
  /** Per type, sorted by decided count descending then type ascending. */
  byType: {
    type: string;
    decided: number;
    enacted: number;
    expired: number;
    closed: number;
    /** Null unless at least 3 decided rows of this type have both epochs. */
    medianEpochs: number | null;
  }[];
}

const WINDOW_EPOCHS = 12;
const MIN_TYPE_ROWS_FOR_MEDIAN = 3;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Four-decimal percent of part out of total, BigInt-safe, 0 when total is 0 or negative. */
function pct4(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 1_000_000n) / total) / 10_000;
}

/** Whether a body's tally met its threshold, null unless both are known. */
function verdict(thresholdPct: number | null | undefined, yesPct: number | null): boolean | null {
  if (thresholdPct == null || yesPct == null) return null;
  return yesPct >= thresholdPct;
}

/**
 * SPO turnout for one action: (yes + no + abstain) over (yes + noSide +
 * abstain + alwaysAbstain), the same ledger-counted "no side" the full-stake
 * bar uses elsewhere. Null unless all four stake fields are present and the
 * TEXT ones parse.
 */
function spoTurnoutPct(row: DecidedOutcomeRow): number | null {
  if (
    row.spoYesPower == null ||
    row.spoNoPower == null ||
    row.spoAbstainPower == null ||
    row.spoNoSidePower == null ||
    row.spoAlwaysAbstainPower == null
  ) {
    return null;
  }
  let noSide: bigint;
  let alwaysAbstain: bigint;
  try {
    noSide = BigInt(row.spoNoSidePower);
    alwaysAbstain = BigInt(row.spoAlwaysAbstainPower);
  } catch {
    return null;
  }
  const yes = BigInt(row.spoYesPower);
  const no = BigInt(row.spoNoPower);
  const abstain = BigInt(row.spoAbstainPower);
  const numerator = yes + no + abstain;
  const denominator = yes + noSide + abstain + alwaysAbstain;
  return pct4(numerator, denominator);
}

/**
 * SPO oversight snapshot: eligibility (an action carries an on-chain SPO
 * threshold), median turnout among the eligible actions whose full stake
 * tally is present, and how often the DRep and SPO verdicts diverge.
 */
export function buildSpoSnapshot(rows: DecidedOutcomeRow[]): SpoSnapshot {
  let eligible = 0;
  let turnoutExcluded = 0;
  let divergent = 0;
  let divergenceBasis = 0;
  const turnouts: number[] = [];
  const divergentActions: DivergentAction[] = [];

  for (const row of rows) {
    const snapshot = readThresholdSnapshot(row.thresholdsJson);
    if (snapshot?.spo != null) {
      eligible += 1;
      const turnout = spoTurnoutPct(row);
      if (turnout == null) {
        turnoutExcluded += 1;
      } else {
        turnouts.push(turnout);
      }
    }

    // An enacted or ratified action proves both bodies met their threshold by the chain
    // outcome itself, since the action could not have passed otherwise, so chain proof
    // overrides the stored SPO percentage here, which for every action type but hard
    // forks still reflects the pre-Plomin reading where a non-voting pool counts as No
    // and can understate a real pass.
    const chainProven = row.status === 'enacted' || row.status === 'ratified';
    const drepVerdict = chainProven && snapshot?.drep != null ? true : verdict(snapshot?.drep, row.drepYesPct);
    const spoVerdict = chainProven && snapshot?.spo != null ? true : verdict(snapshot?.spo, row.spoYesPct);
    if (drepVerdict !== null && spoVerdict !== null) {
      divergenceBasis += 1;
      if (drepVerdict !== spoVerdict) {
        divergent += 1;
        // Exactly one body's verdict is false when they differ, since both are
        // known here (divergenceBasis already guards that) and a chain-proven
        // row (enacted/ratified) forces both verdicts true, so it never reaches
        // this branch at all.
        divergentActions.push({
          gaId: row.gaId,
          title: row.title,
          href: row.topicSlug != null ? `/t/${row.topicSlug}/` : null,
          type: row.type,
          missedBy: drepVerdict === false ? 'DRep' : 'SPO',
        });
      }
    }
  }

  return {
    eligible,
    medianTurnoutPct: median(turnouts),
    turnoutBasis: turnouts.length,
    turnoutExcluded,
    divergent,
    divergenceBasis,
    divergentActions,
  };
}

/** Epochs from submission to decision, null unless the action has a known submission epoch. */
function epochsToDecision(row: DecidedOutcomeRow): number | null {
  return row.submittedEpoch == null ? null : row.decidedEpoch - row.submittedEpoch;
}

/**
 * Governance throughput: recent submission volume, terminal-status counts
 * (read from the full-table status tally, since still-active actions never
 * reach the decided rows), and overall plus per-type median epochs from
 * submission to decision. A per-type median needs at least 3 decided rows
 * of that type with a known submission epoch, otherwise it is null but the
 * type's counts still show.
 */
export function buildThroughput(
  rows: DecidedOutcomeRow[],
  statusCounts: Record<string, number>,
  submittedRecent: number,
): ThroughputView {
  const overallSpans: number[] = [];
  const byType = new Map<
    string,
    { decided: number; enacted: number; expired: number; closed: number; spans: number[] }
  >();

  for (const row of rows) {
    const span = epochsToDecision(row);
    if (span != null) overallSpans.push(span);

    const entry = byType.get(row.type) ?? { decided: 0, enacted: 0, expired: 0, closed: 0, spans: [] };
    entry.decided += 1;
    // A ratified row is still pending its enactment epoch on chain, so it counts as
    // enacted here rather than getting its own bucket.
    if (row.status === 'enacted' || row.status === 'ratified') entry.enacted += 1;
    else if (row.status === 'expired') entry.expired += 1;
    else if (row.status === 'closed') entry.closed += 1;
    if (span != null) entry.spans.push(span);
    byType.set(row.type, entry);
  }

  const byTypeRows = [...byType.entries()]
    .map(([type, e]) => ({
      type,
      decided: e.decided,
      enacted: e.enacted,
      expired: e.expired,
      closed: e.closed,
      medianEpochs: e.spans.length >= MIN_TYPE_ROWS_FOR_MEDIAN ? median(e.spans) : null,
    }))
    .sort((a, b) => b.decided - a.decided || a.type.localeCompare(b.type));

  return {
    submittedRecent,
    windowEpochs: WINDOW_EPOCHS,
    // A ratified row is still pending its enactment epoch on chain, so it counts as
    // enacted here rather than getting its own tile.
    enacted: (statusCounts.enacted ?? 0) + (statusCounts.ratified ?? 0),
    expired: statusCounts.expired ?? 0,
    closed: statusCounts.closed ?? 0,
    dropped: statusCounts.dropped ?? 0,
    active: statusCounts.active ?? 0,
    medianEpochsToDecision: median(overallSpans),
    decisionBasis: overallSpans.length,
    byType: byTypeRows,
  };
}

/**
 * A dropped action as the hub lists it: what it was, when it left the
 * proposal set, and, where the chain says so, the action that superseded it.
 */
export interface DroppedActionView {
  gaId: string;
  title: string | null;
  href: string | null;
  type: string;
  droppedEpoch: number | null;
  /** Epochs of voting the action still had left when it was removed, when both epochs are known. */
  epochsLeft: number | null;
  supersededBy: { title: string | null; href: string | null; type: string; epoch: number | null } | null;
}

/**
 * Pairs each dropped action with the enacted action that took its place in
 * the lineage: same predecessor, decided no later than the drop. A dropped
 * action with no such sibling (a type without a lineage, or a drop caused by
 * something else) keeps a null, the page then states no reason rather than
 * guessing one.
 */
export function buildDroppedActions(
  dropped: LineageActionRow[],
  successors: LineageActionRow[],
): DroppedActionView[] {
  const href = (row: LineageActionRow) => (row.topicSlug ? `/t/${row.topicSlug}/` : null);
  // Parsed once per successor, not once per successor per dropped action.
  const withPrev = successors.map((row) => ({ row, prev: lineagePredecessor(row.payload) }));
  return dropped.map((row) => {
    const prev = lineagePredecessor(row.payload);
    const match = prev == null
      ? null
      : withPrev
          .filter(
            (s) =>
              s.row.gaId !== row.gaId &&
              s.prev === prev &&
              s.row.decidedEpoch != null &&
              (row.decidedEpoch == null || s.row.decidedEpoch <= row.decidedEpoch),
          )
          // The latest one at or before the drop is the enactment that moved
          // the lineage tip past this action.
          .sort((a, b) => (b.row.decidedEpoch ?? 0) - (a.row.decidedEpoch ?? 0))[0]?.row ?? null;
    return {
      gaId: row.gaId,
      title: row.title,
      href: href(row),
      type: row.type,
      droppedEpoch: row.decidedEpoch,
      epochsLeft:
        row.decidedEpoch != null && row.expiryEpoch != null && row.expiryEpoch > row.decidedEpoch
          ? row.expiryEpoch - row.decidedEpoch
          : null,
      supersededBy: match
        ? { title: match.title, href: href(match), type: match.type, epoch: match.decidedEpoch }
        : null,
    };
  });
}
