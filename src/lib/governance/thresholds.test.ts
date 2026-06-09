import { describe, it, expect } from 'vitest';
import { evaluateThresholds } from './thresholds.js';
import type { ProtocolParams } from '../db/protocolParams.js';

const P: ProtocolParams = {
  epoch: 540, dvtMotionNoConfidence: 0.67, dvtCommitteeNormal: 0.67, dvtCommitteeNoConfidence: 0.6,
  dvtUpdateConstitution: 0.75, dvtHardFork: 0.6, dvtPpNetwork: 0.67, dvtPpEconomic: 0.67,
  dvtPpTechnical: 0.67, dvtPpGov: 0.75, dvtTreasuryWithdrawal: 0.67,
  pvtMotionNoConfidence: 0.51, pvtCommitteeNormal: 0.51, pvtCommitteeNoConfidence: 0.51,
  pvtHardFork: 0.51, pvtSecurityGroup: 0.51, ccThreshold: 0.67, committeeMinSize: 7, syncedAt: 0,
};

describe('evaluateThresholds', () => {
  it('TreasuryWithdrawals: DRep 0.67 + CC, no SPO; met when yes pct >= threshold', () => {
    const r = evaluateThresholds({ type: 'TreasuryWithdrawals', drepYesPct: 70, spoYesPct: null, ccYesPct: 80, ccSize: 7 }, P);
    const drep = r.find((b) => b.body === 'DRep')!;
    expect(drep.thresholdPct).toBe(67);
    expect(drep.met).toBe(true);
    expect(r.some((b) => b.body === 'SPO')).toBe(false);
    expect(r.find((b) => b.body === 'CC')!.met).toBe(true);
  });
  it('InfoAction: no on-chain threshold (empty)', () => {
    expect(evaluateThresholds({ type: 'InfoAction', drepYesPct: 99, spoYesPct: 99, ccYesPct: 99, ccSize: 7 }, P)).toEqual([]);
  });
  it('HardForkInitiation: DRep + SPO + CC', () => {
    const r = evaluateThresholds({ type: 'HardForkInitiation', drepYesPct: 50, spoYesPct: 60, ccYesPct: 70, ccSize: 7 }, P);
    expect(r.map((b) => b.body).sort()).toEqual(['CC', 'DRep', 'SPO']);
    expect(r.find((b) => b.body === 'DRep')!.met).toBe(false); // 50 < 60
    expect(r.find((b) => b.body === 'SPO')!.met).toBe(true);   // 60 >= 51
  });
  it('CC fails quorum when committee smaller than min size', () => {
    const r = evaluateThresholds({ type: 'TreasuryWithdrawals', drepYesPct: 70, spoYesPct: null, ccYesPct: 100, ccSize: 3 }, P);
    expect(r.find((b) => b.body === 'CC')!.met).toBe(false); // 3 < 7
  });
  it('NewConstitution: DRep 0.75 + CC, no SPO', () => {
    const r = evaluateThresholds({ type: 'NewConstitution', drepYesPct: 76, spoYesPct: null, ccYesPct: 70, ccSize: 7 }, P);
    expect(r.find((b) => b.body === 'DRep')!.thresholdPct).toBe(75);
    expect(r.some((b) => b.body === 'SPO')).toBe(false);
  });
});
