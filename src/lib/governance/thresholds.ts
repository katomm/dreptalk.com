// Pure CIP-1694 threshold evaluation. Maps a governance action type to the
// bodies that vote and the threshold each must clear, then checks the stored
// yes-percentages against them. Thresholds come from protocol_params (fractions
// 0..1); the tallies arrive as percentages 0..100.
import type { ProtocolParams } from '../db/protocolParams.js';
import { koiosProposalType } from './prevAction.js';
import type { GovActionFormType } from './prevAction.js';

export type Body = 'DRep' | 'SPO' | 'CC';

// The four DRep parameter groups a ParameterChange can touch (CIP-1694). Defined
// here, not in onchain.ts, so the threshold evaluation has no import cycle; the
// payload-to-scope decoder in onchain.ts imports these types from here.
export type ParamGroup = 'network' | 'economic' | 'technical' | 'governance';

export interface ParamChangeScope {
  groups: ParamGroup[];     // DRep groups the change touches
  touchesSecurity: boolean; // any changed parameter is security-relevant (adds the SPO vote)
}

export interface BodyResult {
  body: Body;
  thresholdPct: number | null; // 0..100, null when params not synced
  yesPct: number | null;       // 0..100
  met: boolean;
}

export interface ThresholdInput {
  type: string;
  drepYesPct: number | null;
  spoYesPct: number | null;
  ccYesPct: number | null;
  // For ParameterChange only: which groups the change touches and whether SPOs
  // vote. Null/absent when the on-chain payload is unavailable.
  paramScope?: ParamChangeScope | null;
}

// The strictest (highest) of a set of group threshold fractions, null if none.
function strictest(vals: (number | null)[]): number | null {
  return Math.max(0, ...vals.map((v) => v ?? 0)) || null;
}

// ParameterChange voting: DReps vote at the strictest threshold of the groups the
// change actually touches; SPOs vote only when a security-relevant parameter
// changes (constitution PARAM-03a). When the payload is unavailable (scope null)
// we cannot prove either, so DReps fall back to the strictest of all four groups
// and the SPO vote is omitted rather than invented. CC always votes.
function planParameterChange(scope: ParamChangeScope | null | undefined, p: ProtocolParams) {
  const groupThr: Record<ParamGroup, number | null> = {
    network: p.dvtPpNetwork,
    economic: p.dvtPpEconomic,
    technical: p.dvtPpTechnical,
    governance: p.dvtPpGov,
  };
  const drep =
    scope?.groups.length
      ? strictest(scope.groups.map((g) => groupThr[g]))
      : strictest([p.dvtPpNetwork, p.dvtPpEconomic, p.dvtPpTechnical, p.dvtPpGov]);
  return { drep, spo: scope?.touchesSecurity ? p.pvtSecurityGroup : null, cc: true };
}

// Per action: DRep threshold fraction, SPO threshold fraction (or null = no SPO),
// and whether the CC votes. Returns null for types with no on-chain threshold.
function plan(input: ThresholdInput, p: ProtocolParams): { drep: number | null; spo: number | null; cc: boolean } | null {
  switch (input.type) {
    case 'InfoAction':
      return null;
    case 'NoConfidence':
      return { drep: p.dvtMotionNoConfidence, spo: p.pvtMotionNoConfidence, cc: false };
    case 'NewCommittee':
      return { drep: p.dvtCommitteeNormal, spo: p.pvtCommitteeNormal, cc: false };
    case 'NewConstitution':
      return { drep: p.dvtUpdateConstitution, spo: null, cc: true };
    case 'HardForkInitiation':
      return { drep: p.dvtHardFork, spo: p.pvtHardFork, cc: true };
    case 'TreasuryWithdrawals':
      return { drep: p.dvtTreasuryWithdrawal, spo: null, cc: true };
    case 'ParameterChange':
      return planParameterChange(input.paramScope, p);
    default:
      return null;
  }
}

// The action types SPOs vote on at all (CIP-1694). ParameterChange is absent
// because there it depends on the changed parameters, which the caller passes
// as a scope.
const SPO_VOTING_TYPES = new Set(['NoConfidence', 'NewCommittee', 'HardForkInitiation']);

/** A threshold fraction as a percentage string, trailing zeros trimmed. */
function thresholdPctLabel(fraction: number | null): string {
  if (fraction == null) return 'unknown';
  const pct = Math.round(fraction * 1000) / 10;
  return `${pct}%`;
}

/**
 * One sentence naming the DRep and SPO thresholds an action type needs and
 * whether the constitutional committee votes on it, for the /ga/new type
 * selector cards. The committee's own quorum is deliberately absent: it does
 * not come from epoch_params, so the card would be stating a figure it has
 * not read.
 *
 * The committee-chain types (NoConfidence and UpdateCommittee) carry a
 * closing clause, because the figures describe the normal state only: once a
 * no-confidence motion has passed, the ledger switches to the
 * *_committee_no_confidence thresholds, a state this form does not model.
 */
export function thresholdSentence(type: GovActionFormType, p: ProtocolParams, paramScope?: ParamChangeScope): string {
  // The form's type names differ from Koios's in one place (UpdateCommittee
  // vs NewCommittee), which prevAction.ts owns, so there is exactly one
  // threshold table here and one mapping there.
  const koiosType = koiosProposalType(type);
  const pl = plan({ type: koiosType, drepYesPct: null, spoYesPct: null, ccYesPct: null, paramScope }, p);
  if (!pl) return 'No ratification thresholds, an InfoAction is advisory and never enacts.';

  // Whether SPOs vote at all is a property of the action type, not of the
  // stored figure: an unsynced pvt_* parameter leaves plan().spo null for a
  // type SPOs do vote on, and the card must then say unknown, not go silent.
  const parts = [`DReps ${thresholdPctLabel(pl.drep)}`];
  if (SPO_VOTING_TYPES.has(koiosType)) parts.push(`SPOs ${thresholdPctLabel(pl.spo)}`);
  if (koiosType === 'ParameterChange' && paramScope) {
    parts.push(paramScope.touchesSecurity ? `SPOs ${thresholdPctLabel(pl.spo)}` : 'stake pools do not vote on these parameters');
  }
  parts.push(pl.cc ? 'the committee votes' : 'the committee does not vote');
  const suffix =
    koiosType === 'NoConfidence' || koiosType === 'NewCommittee'
      ? ' (normal state, after a no-confidence vote different committee thresholds apply)'
      : '';
  return `${parts.join(', ')}${suffix}.`;
}

/** The DRep threshold in percent (one decimal) for a type and parameter scope, null while unknown. */
export function drepThresholdPct(type: GovActionFormType, p: ProtocolParams | null, paramScope?: ParamChangeScope): number | null {
  if (!p) return null;
  const pl = plan({ type: koiosProposalType(type), drepYesPct: null, spoYesPct: null, ccYesPct: null, paramScope }, p);
  return pl?.drep == null ? null : Math.round(pl.drep * 1000) / 10;
}

// Non-null placeholder params for decidersLine's plan() probe. Only the
// null-vs-set shape of spo and the cc flag matter there, never the numeric
// thresholds, so any non-null values work.
const PROBE_PARAMS: ProtocolParams = {
  epoch: 0,
  dvtMotionNoConfidence: 1, dvtCommitteeNormal: 1, dvtCommitteeNoConfidence: 1,
  dvtUpdateConstitution: 1, dvtHardFork: 1, dvtPpNetwork: 1, dvtPpEconomic: 1,
  dvtPpTechnical: 1, dvtPpGov: 1, dvtTreasuryWithdrawal: 1,
  pvtMotionNoConfidence: 1, pvtCommitteeNormal: 1, pvtCommitteeNoConfidence: 1,
  pvtHardFork: 1, pvtSecurityGroup: 1, ccThreshold: 1, committeeMinSize: null, committeeSize: null,
  syncedAt: 0, rawJson: null,
  treasuryLovelace: null, reservesLovelace: null, circulationLovelace: null, treasuryEpoch: null,
};

/**
 * One line naming who decides an action type, for the /ga/new type selector
 * cards. Derived from plan() (which body votes and whether the committee
 * votes), the same table thresholdSentence reads, so the two can never say
 * different things about who votes. InfoAction is not on-chain at all
 * (plan() returns null for it) so its line is written out here rather than
 * derived.
 */
export function decidersLine(type: GovActionFormType): string {
  if (type === 'InfoAction') {
    return 'Advisory, never ratified, DReps and SPOs vote to signal';
  }
  const koiosType = koiosProposalType(type);
  const pl = plan({ type: koiosType, drepYesPct: null, spoYesPct: null, ccYesPct: null }, PROBE_PARAMS);
  const spoVotes = pl?.spo != null;
  const ccVotes = pl?.cc ?? false;
  if (spoVotes && ccVotes) return 'Decided by DReps, SPOs and the committee';
  if (spoVotes) return 'Decided by DReps and SPOs';
  if (ccVotes) return 'Decided by DReps and the committee';
  return 'Decided by DReps';
}

/**
 * Whether an action type carries an on-chain ratification threshold. Only
 * InfoAction is advisory and has none; every other governance action type carries
 * one. Kept next to plan() (which returns null for the same advisory case) so the
 * two never drift, and so the "no threshold" knowledge lives in one place.
 */
export function hasOnchainThreshold(type: string): boolean {
  return type !== 'InfoAction';
}

const pctOf = (frac: number | null): number | null => (frac == null ? null : frac * 100);
const meets = (yes: number | null, thrPct: number | null): boolean =>
  yes != null && thrPct != null && yes >= thrPct;

export function evaluateThresholds(input: ThresholdInput, p: ProtocolParams): BodyResult[] {
  const pl = plan(input, p);
  if (!pl) return [];
  const out: BodyResult[] = [];
  if (pl.drep != null) {
    const thr = pctOf(pl.drep);
    out.push({ body: 'DRep', thresholdPct: thr, yesPct: input.drepYesPct, met: meets(input.drepYesPct, thr) });
  }
  if (pl.spo != null) {
    const thr = pctOf(pl.spo);
    out.push({ body: 'SPO', thresholdPct: thr, yesPct: input.spoYesPct, met: meets(input.spoYesPct, thr) });
  }
  if (pl.cc) {
    const thr = pctOf(p.ccThreshold);
    // CIP-1694 min-size rule: the committee cannot ratify while its active
    // membership is below committee_min_size. Only gate when both figures are
    // known; missing data must not flip the row to "Not met". Note this is the
    // committee's size, not the number of votes cast: members who skip a vote
    // already count against the yes-percentage, they do not shrink the committee.
    const belowMinSize =
      p.committeeMinSize != null && p.committeeSize != null && p.committeeSize < p.committeeMinSize;
    out.push({ body: 'CC', thresholdPct: thr, yesPct: input.ccYesPct, met: !belowMinSize && meets(input.ccYesPct, thr) });
  }
  return out;
}

/** Per-body threshold percentages (0..100), frozen with an action at its decision. */
// Snapshot schema version. v1 (no `v` field): per-body threshold percentages.
// v2: plus ccBelowMinSize, the frozen committee quorum gate. v3: the gate is
// measured at the decision boundary (see decisionBoundaryEpoch) with its
// provenance, plus the outcome check. Bumping it re-drives the backfill.
export const THRESHOLD_SNAPSHOT_VERSION = 3;

/** Where the frozen committee minimum came from: the parameters of the boundary epoch, or the live cache for an action still open. */
export type CcMinSizeSource = 'epoch-params' | 'live';

export interface CcGateProvenance {
  /** The epoch whose opening boundary the committee was resolved at. */
  boundaryEpoch: number | null;
  /** Members the ledger counted at that boundary (authorized, unexpired, not yet resigned). */
  sizeAtBoundary: number | null;
  /** The committee minimum size in force for that boundary. */
  minSize: number | null;
  minSizeSource: CcMinSizeSource | null;
}

export interface ThresholdSnapshot {
  drep: number | null;
  spo: number | null;
  cc: number | null;
  /** The committee was too small to act (size < min size) at the decision boundary.
      Null when unknown (a v1 snapshot, or committee size/min not resolvable). */
  ccBelowMinSize: boolean | null;
  /** Provenance of the gate. Null on snapshots older than v3. */
  ccGate: CcGateProvenance | null;
  /** The stored tallies fail a threshold the ledger evidently accepted (the action
      is ratified or enacted): the percentage is reported, not reconciled. Null
      when the outcome or the tallies were not known at freeze time. */
  tallyContradictsOutcome: boolean | null;
  /** Snapshot schema version; 0 for a legacy v1 snapshot with no version field. */
  v: number;
}

/** Whether the active committee was below its minimum size (the CC quorum gate). */
export function committeeBelowMinSize(size: number | null, minSize: number | null): boolean | null {
  if (size == null || minSize == null) return null;
  return size < minSize;
}

/**
 * Whether stored tallies contradict a ratified or enacted outcome: a required
 * body's share reads below its bar, or the committee (where it votes on this
 * type) was frozen as below its minimum. Judged on the shares and the frozen
 * gate only, never on `met`, which for the CC folds in today's committee size.
 * A body that cast no ballot at all is not judged: a ratified action with zero
 * DRep ballots is a bootstrap-era decision, where the DRep bar did not apply.
 */
export function tallyContradictsOutcome(
  results: BodyResult[],
  status: string | null,
  ccBelowMinSize: boolean | null,
  ballots: Partial<Record<Body, number | null>> = {},
): boolean | null {
  if (status !== 'ratified' && status !== 'enacted') return null;
  if (results.length === 0) return null;
  const judged = results.filter(
    (r): r is BodyResult & { yesPct: number; thresholdPct: number } => r.yesPct != null && r.thresholdPct != null && ballots[r.body] !== 0,
  );
  if (judged.length === 0) return null;
  const ccVotes = results.some((r) => r.body === 'CC');
  return judged.some((r) => r.yesPct < r.thresholdPct) || (ccVotes && ccBelowMinSize === true);
}

/**
 * Serializes evaluated per-body thresholds plus the frozen CC quorum gate (and,
 * for v3, its provenance and the outcome check) to the stored thresholds_json string.
 */
export function serializeThresholdSnapshot(
  results: BodyResult[],
  ccBelowMinSize: boolean | null,
  extra: { ccGate?: CcGateProvenance | null; tallyContradictsOutcome?: boolean | null } = {},
): string {
  const snap: ThresholdSnapshot = {
    drep: null,
    spo: null,
    cc: null,
    ccBelowMinSize,
    ccGate: extra.ccGate ?? null,
    tallyContradictsOutcome: extra.tallyContradictsOutcome ?? null,
    v: THRESHOLD_SNAPSHOT_VERSION,
  };
  for (const r of results) {
    if (r.body === 'DRep') snap.drep = r.thresholdPct;
    else if (r.body === 'SPO') snap.spo = r.thresholdPct;
    else if (r.body === 'CC') snap.cc = r.thresholdPct;
  }
  return JSON.stringify(snap);
}

function readGate(o: unknown): CcGateProvenance | null {
  if (!o || typeof o !== 'object') return null;
  const g = o as Partial<CcGateProvenance>;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    boundaryEpoch: num(g.boundaryEpoch),
    sizeAtBoundary: num(g.sizeAtBoundary),
    minSize: num(g.minSize),
    minSizeSource: g.minSizeSource === 'epoch-params' || g.minSizeSource === 'live' ? g.minSizeSource : null,
  };
}

/** Parses a stored thresholds_json string; null when absent or malformed. */
export function readThresholdSnapshot(json: string | null): ThresholdSnapshot | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Partial<ThresholdSnapshot>;
    return {
      drep: typeof o.drep === 'number' ? o.drep : null,
      spo: typeof o.spo === 'number' ? o.spo : null,
      cc: typeof o.cc === 'number' ? o.cc : null,
      ccBelowMinSize: typeof o.ccBelowMinSize === 'boolean' ? o.ccBelowMinSize : null,
      ccGate: readGate(o.ccGate),
      tallyContradictsOutcome: typeof o.tallyContradictsOutcome === 'boolean' ? o.tallyContradictsOutcome : null,
      v: typeof o.v === 'number' ? o.v : 0,
    };
  } catch {
    return null;
  }
}
