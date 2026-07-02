import { describe, it, expect } from 'vitest';
import { evaluateThresholds } from './thresholds.js';
import type { ProtocolParams } from '../db/protocolParams.js';

const P: ProtocolParams = {
  epoch: 540, dvtMotionNoConfidence: 0.67, dvtCommitteeNormal: 0.67, dvtCommitteeNoConfidence: 0.6,
  dvtUpdateConstitution: 0.75, dvtHardFork: 0.6, dvtPpNetwork: 0.67, dvtPpEconomic: 0.67,
  dvtPpTechnical: 0.67, dvtPpGov: 0.75, dvtTreasuryWithdrawal: 0.67,
  pvtMotionNoConfidence: 0.51, pvtCommitteeNormal: 0.51, pvtCommitteeNoConfidence: 0.51,
  pvtHardFork: 0.51, pvtSecurityGroup: 0.51, ccThreshold: 0.67, committeeMinSize: 7, committeeSize: 8,
  syncedAt: 0, rawJson: null,
};

describe('evaluateThresholds', () => {
  it('TreasuryWithdrawals: DRep 0.67 + CC, no SPO; met when yes pct >= threshold', () => {
    const r = evaluateThresholds({ type: 'TreasuryWithdrawals', drepYesPct: 70, spoYesPct: null, ccYesPct: 80 }, P);
    const drep = r.find((b) => b.body === 'DRep')!;
    expect(drep.thresholdPct).toBe(67);
    expect(drep.met).toBe(true);
    expect(r.some((b) => b.body === 'SPO')).toBe(false);
    expect(r.find((b) => b.body === 'CC')!.met).toBe(true);
  });
  it('InfoAction: no on-chain threshold (empty)', () => {
    expect(evaluateThresholds({ type: 'InfoAction', drepYesPct: 99, spoYesPct: 99, ccYesPct: 99 }, P)).toEqual([]);
  });
  it('HardForkInitiation: DRep + SPO + CC', () => {
    const r = evaluateThresholds({ type: 'HardForkInitiation', drepYesPct: 50, spoYesPct: 60, ccYesPct: 70 }, P);
    expect(r.map((b) => b.body).sort()).toEqual(['CC', 'DRep', 'SPO']);
    expect(r.find((b) => b.body === 'DRep')!.met).toBe(false); // 50 < 60
    expect(r.find((b) => b.body === 'SPO')!.met).toBe(true);   // 60 >= 51
  });
  it('CC fails quorum when committee smaller than min size', () => {
    const r = evaluateThresholds(
      { type: 'TreasuryWithdrawals', drepYesPct: 70, spoYesPct: null, ccYesPct: 100 },
      { ...P, committeeSize: 3 },
    );
    expect(r.find((b) => b.body === 'CC')!.met).toBe(false); // 3 < 7
  });
  it('CC quorum gate is skipped when committee size is unknown', () => {
    const r = evaluateThresholds(
      { type: 'TreasuryWithdrawals', drepYesPct: 70, spoYesPct: null, ccYesPct: 75 },
      { ...P, committeeSize: null },
    );
    expect(r.find((b) => b.body === 'CC')!.met).toBe(true); // 75 >= 67; no size data, no gate
  });
  it('CC met purely by threshold when committeeMinSize is missing', () => {
    const r = evaluateThresholds(
      { type: 'TreasuryWithdrawals', drepYesPct: 70, spoYesPct: null, ccYesPct: 75 },
      { ...P, committeeMinSize: null },
    );
    expect(r.find((b) => b.body === 'CC')!.met).toBe(true);
  });
  it('NewConstitution: DRep 0.75 + CC, no SPO', () => {
    const r = evaluateThresholds({ type: 'NewConstitution', drepYesPct: 76, spoYesPct: null, ccYesPct: 70 }, P);
    expect(r.find((b) => b.body === 'DRep')!.thresholdPct).toBe(75);
    expect(r.some((b) => b.body === 'SPO')).toBe(false);
  });

  describe('ParameterChange', () => {
    const base = { type: 'ParameterChange', drepYesPct: 80, spoYesPct: 60, ccYesPct: 80 } as const;

    it('governance-only change: DRep gov threshold + CC, no SPO', () => {
      const r = evaluateThresholds({ ...base, paramScope: { groups: ['governance'], touchesSecurity: false } }, P);
      expect(r.find((b) => b.body === 'DRep')!.thresholdPct).toBe(75);
      expect(r.some((b) => b.body === 'SPO')).toBe(false);
      expect(r.some((b) => b.body === 'CC')).toBe(true);
    });

    it('security-relevant change: adds the SPO security-group threshold', () => {
      const r = evaluateThresholds({ ...base, paramScope: { groups: ['economic'], touchesSecurity: true } }, P);
      expect(r.find((b) => b.body === 'DRep')!.thresholdPct).toBe(67);
      expect(r.find((b) => b.body === 'SPO')!.thresholdPct).toBe(51);
    });

    it('multiple groups: DRep takes the strictest group threshold', () => {
      const r = evaluateThresholds({ ...base, paramScope: { groups: ['network', 'governance'], touchesSecurity: false } }, P);
      expect(r.find((b) => b.body === 'DRep')!.thresholdPct).toBe(75); // max(67, 75)
      expect(r.some((b) => b.body === 'SPO')).toBe(false);
    });

    it('no scope (payload missing): DRep strictest of all groups, SPO omitted', () => {
      const r = evaluateThresholds({ ...base }, P);
      expect(r.find((b) => b.body === 'DRep')!.thresholdPct).toBe(75); // max of all four
      expect(r.some((b) => b.body === 'SPO')).toBe(false);
    });
  });
});
