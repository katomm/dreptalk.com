// Pure CIP-1694 threshold evaluation. Maps a governance action type to the
// bodies that vote and the threshold each must clear, then checks the stored
// yes-percentages against them. Thresholds come from protocol_params (fractions
// 0..1); the tallies arrive as percentages 0..100.
import type { ProtocolParams } from '../db/protocolParams.js';

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
export interface ThresholdSnapshot {
  drep: number | null;
  spo: number | null;
  cc: number | null;
}

/** Serializes evaluated per-body thresholds to the stored thresholds_json string. */
export function serializeThresholdSnapshot(results: BodyResult[]): string {
  const snap: ThresholdSnapshot = { drep: null, spo: null, cc: null };
  for (const r of results) {
    if (r.body === 'DRep') snap.drep = r.thresholdPct;
    else if (r.body === 'SPO') snap.spo = r.thresholdPct;
    else if (r.body === 'CC') snap.cc = r.thresholdPct;
  }
  return JSON.stringify(snap);
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
    };
  } catch {
    return null;
  }
}
