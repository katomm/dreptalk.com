import { describe, it, expect } from 'vitest';
import {
  evaluateThresholds,
  serializeThresholdSnapshot,
  readThresholdSnapshot,
  committeeBelowMinSize,
  tallyContradictsOutcome,
  THRESHOLD_SNAPSHOT_VERSION,
} from './thresholds.js';
import type { BodyResult } from './thresholds.js';
import type { ProtocolParams } from '../db/protocolParams.js';

const P: ProtocolParams = {
  epoch: 540, dvtMotionNoConfidence: 0.67, dvtCommitteeNormal: 0.67, dvtCommitteeNoConfidence: 0.6,
  dvtUpdateConstitution: 0.75, dvtHardFork: 0.6, dvtPpNetwork: 0.67, dvtPpEconomic: 0.67,
  dvtPpTechnical: 0.67, dvtPpGov: 0.75, dvtTreasuryWithdrawal: 0.67,
  pvtMotionNoConfidence: 0.51, pvtCommitteeNormal: 0.51, pvtCommitteeNoConfidence: 0.51,
  pvtHardFork: 0.51, pvtSecurityGroup: 0.51, ccThreshold: 0.67, committeeMinSize: 7, committeeSize: 8,
  syncedAt: 0, rawJson: null,
  treasuryLovelace: null, reservesLovelace: null, circulationLovelace: null, treasuryEpoch: null,
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

describe('threshold snapshot', () => {
  it('serializes per-body threshold pct plus the cc quorum gate and reads it back', () => {
    const results: BodyResult[] = [
      { body: 'DRep', thresholdPct: 67, yesPct: 70, met: true },
      { body: 'CC', thresholdPct: 66.67, yesPct: 80, met: true },
    ];
    const json = serializeThresholdSnapshot(results, false);
    expect(readThresholdSnapshot(json)).toEqual({
      drep: 67,
      spo: null,
      cc: 66.67,
      ccBelowMinSize: false,
      ccGate: null,
      tallyContradictsOutcome: null,
      v: THRESHOLD_SNAPSHOT_VERSION,
    });
  });

  it('carries the gate provenance and the outcome check through the round-trip', () => {
    const gate = { boundaryEpoch: 597, sizeAtBoundary: 7, minSize: 7, minSizeSource: 'epoch-params' as const };
    const json = serializeThresholdSnapshot([{ body: 'CC', thresholdPct: 66.67, yesPct: 100, met: true }], false, { ccGate: gate, tallyContradictsOutcome: false });
    const snap = readThresholdSnapshot(json);
    expect(snap?.ccGate).toEqual(gate);
    expect(snap?.tallyContradictsOutcome).toBe(false);
    expect(snap?.v).toBe(3);
  });

  it('carries a true cc quorum gate through the round-trip', () => {
    const json = serializeThresholdSnapshot([{ body: 'CC', thresholdPct: 66.67, yesPct: 80, met: false }], true);
    const snap = readThresholdSnapshot(json);
    expect(snap?.ccBelowMinSize).toBe(true);
    expect(snap?.v).toBe(THRESHOLD_SNAPSHOT_VERSION);
  });

  it('reads a legacy v1 snapshot (no version, no gate) as ccBelowMinSize null and v 0', () => {
    expect(readThresholdSnapshot('{"drep":67,"spo":null,"cc":66.67}')).toEqual({
      drep: 67,
      spo: null,
      cc: 66.67,
      ccBelowMinSize: null,
      ccGate: null,
      tallyContradictsOutcome: null,
      v: 0,
    });
  });

  it('returns null for absent or malformed json', () => {
    expect(readThresholdSnapshot(null)).toBeNull();
    expect(readThresholdSnapshot('not json')).toBeNull();
  });
});

describe('tallyContradictsOutcome', () => {
  const met: BodyResult = { body: 'DRep', thresholdPct: 67, yesPct: 79.38, met: true };
  const short: BodyResult = { body: 'SPO', thresholdPct: 51, yesPct: 49.45, met: false };

  it('flags a ratified or enacted action whose stored tally reads below a bar', () => {
    expect(tallyContradictsOutcome([met, short], 'enacted', false)).toBe(true);
    expect(tallyContradictsOutcome([met, short], 'ratified', false)).toBe(true);
    expect(tallyContradictsOutcome([met], 'enacted', true)).toBe(true);
  });

  it('is false when every judged body met its bar', () => {
    expect(tallyContradictsOutcome([met], 'enacted', false)).toBe(false);
  });

  it('is null for an outcome the tallies cannot contradict, or without tallies to judge', () => {
    expect(tallyContradictsOutcome([met, short], 'expired', false)).toBeNull();
    expect(tallyContradictsOutcome([met, short], 'active', false)).toBeNull();
    expect(tallyContradictsOutcome([], 'enacted', false)).toBeNull();
    expect(tallyContradictsOutcome([{ body: 'SPO', thresholdPct: 51, yesPct: null, met: false }], 'enacted', false)).toBeNull();
  });
});

describe('committeeBelowMinSize', () => {
  it('is true when the active committee is under the minimum size', () => {
    expect(committeeBelowMinSize(6, 7)).toBe(true);
  });
  it('is false when the committee meets or exceeds the minimum size', () => {
    expect(committeeBelowMinSize(7, 7)).toBe(false);
    expect(committeeBelowMinSize(9, 5)).toBe(false);
  });
  it('is null when either value is unknown', () => {
    expect(committeeBelowMinSize(null, 7)).toBeNull();
    expect(committeeBelowMinSize(6, null)).toBeNull();
  });
});
