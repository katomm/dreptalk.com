// Pure CIP-1694 threshold evaluation. Maps a governance action type to the
// bodies that vote and the threshold each must clear, then checks the stored
// yes-percentages against them. Thresholds come from protocol_params (fractions
// 0..1); the tallies arrive as percentages 0..100.
import type { ProtocolParams } from '../db/protocolParams.js';

export type Body = 'DRep' | 'SPO' | 'CC';

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
  ccSize: number; // current committee size (members count)
}

// Per type: DRep threshold fraction, SPO threshold fraction (or null = no SPO),
// and whether the CC votes. Returns null for types with no on-chain threshold.
function plan(type: string, p: ProtocolParams): { drep: number | null; spo: number | null; cc: boolean } | null {
  switch (type) {
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
      // v1: strictest DRep pp-group threshold; SPO only via the security group.
      // (Refinement: pick the exact group(s) from the action's param_proposal.)
      return {
        drep: Math.max(p.dvtPpNetwork ?? 0, p.dvtPpEconomic ?? 0, p.dvtPpTechnical ?? 0, p.dvtPpGov ?? 0) || null,
        spo: p.pvtSecurityGroup,
        cc: true,
      };
    default:
      return null;
  }
}

const pctOf = (frac: number | null): number | null => (frac == null ? null : frac * 100);
const meets = (yes: number | null, thrPct: number | null): boolean =>
  yes != null && thrPct != null && yes >= thrPct;

export function evaluateThresholds(input: ThresholdInput, p: ProtocolParams): BodyResult[] {
  const pl = plan(input.type, p);
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
    const quorum = p.committeeMinSize != null && input.ccSize >= p.committeeMinSize;
    out.push({ body: 'CC', thresholdPct: thr, yesPct: input.ccYesPct, met: quorum && meets(input.ccYesPct, thr) });
  }
  return out;
}
