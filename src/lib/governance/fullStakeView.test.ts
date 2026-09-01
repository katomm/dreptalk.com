import { describe, it, expect } from 'vitest';
import { buildFullStakeBar, type FullStakeBarInput } from './fullStakeView.js';

function makeInput(overrides: Partial<FullStakeBarInput> = {}): FullStakeBarInput {
  return {
    actionType: 'ParameterChange',
    activeYesPower: 10,
    activeNoPower: 0,
    activeAbstainPower: 0,
    alwaysAbstainPower: '0',
    alwaysNoConfidencePower: '0',
    reprTotalPower: '100',
    approvalThresholdPct: null,
    ...overrides,
  };
}

describe('buildFullStakeBar', () => {
  describe('progressive enhancement', () => {
    it('returns null when alwaysAbstainPower is missing', () => {
      expect(buildFullStakeBar(makeInput({ alwaysAbstainPower: null }))).toBeNull();
    });

    it('returns null when alwaysNoConfidencePower is missing', () => {
      expect(buildFullStakeBar(makeInput({ alwaysNoConfidencePower: null }))).toBeNull();
    });

    it('returns null when reprTotalPower is missing', () => {
      expect(buildFullStakeBar(makeInput({ reprTotalPower: null }))).toBeNull();
    });

    it('returns null when none of the three active powers is present', () => {
      expect(
        buildFullStakeBar(
          makeInput({ activeYesPower: null, activeNoPower: null, activeAbstainPower: null }),
        ),
      ).toBeNull();
    });

    it('proceeds when only one of the three active powers is present, the rest treated as zero', () => {
      const bar = buildFullStakeBar(
        makeInput({ activeYesPower: null, activeNoPower: null, activeAbstainPower: 30 }),
      );
      expect(bar).not.toBeNull();
      expect(bar!.segments.map((s) => s.key)).toEqual(['activeAbstain', 'notVoted']);
      expect(bar!.segments.map((s) => s.pct)).toEqual([30, 70]);
    });

    it('returns null instead of throwing when a TEXT power column holds malformed text', () => {
      expect(buildFullStakeBar(makeInput({ alwaysAbstainPower: 'not-a-number' }))).toBeNull();
    });
  });

  it('worked example: exact percentages and threshold position on the full-stake axis', () => {
    const bar = buildFullStakeBar(
      makeInput({
        activeYesPower: 600,
        activeNoPower: 100,
        activeAbstainPower: 100,
        alwaysAbstainPower: '800',
        alwaysNoConfidencePower: '200',
        reprTotalPower: '1000',
        approvalThresholdPct: 67,
      }),
    )!;
    expect(bar).not.toBeNull();
    expect(bar.segments.map((s) => s.key)).toEqual([
      'yes',
      'no',
      'activeAbstain',
      'alwaysAbstain',
      'alwaysNoConfidence',
      'notVoted',
    ]);
    expect(bar.segments.map((s) => s.pct)).toEqual([30, 5, 5, 40, 10, 10]);
    expect(bar.thresholdPct).toBe(30.15);
    expect(bar.approvalThresholdPct).toBe(67);
    expect(bar.ancEffect).toBe('no');
  });

  it('ancEffect counts always-no-confidence toward Yes on a NoConfidence action, No otherwise', () => {
    const nc = buildFullStakeBar(makeInput({ actionType: 'NoConfidence' }))!;
    expect(nc.ancEffect).toBe('yes');

    const other = buildFullStakeBar(makeInput({ actionType: 'TreasuryWithdrawals' }))!;
    expect(other.ancEffect).toBe('no');
  });

  it('thresholdPct and approvalThresholdPct are both null when the input threshold is null', () => {
    const bar = buildFullStakeBar(makeInput({ approvalThresholdPct: null }))!;
    expect(bar.thresholdPct).toBeNull();
    expect(bar.approvalThresholdPct).toBeNull();
  });

  it('clamps a threshold position above 100 down to 100', () => {
    const bar = buildFullStakeBar(makeInput({ activeYesPower: 50, approvalThresholdPct: 150 }))!;
    expect(bar.thresholdPct).toBe(100);
  });

  it('clamps a negative threshold position up to 0', () => {
    // activeAbstainPower larger than reprTotal drives (reprTotal - activeAbstain) negative,
    // pushing the raw threshold position below zero before the clamp.
    const bar = buildFullStakeBar(
      makeInput({ activeYesPower: 0, activeAbstainPower: 150, approvalThresholdPct: 67 }),
    )!;
    expect(bar.thresholdPct).toBe(0);
  });

  it('drops zero-valued segments but keeps a positive notVoted', () => {
    const bar = buildFullStakeBar(makeInput({ activeYesPower: 50 }))!;
    expect(bar.segments.map((s) => s.key)).toEqual(['yes', 'notVoted']);
    expect(bar.segments.map((s) => s.pct)).toEqual([50, 50]);
  });

  it('clamps notVoted to zero and drops it when active votes exceed reprTotal', () => {
    const bar = buildFullStakeBar(makeInput({ activeYesPower: 90, activeNoPower: 20 }))!;
    expect(bar.segments.map((s) => s.key)).toEqual(['yes', 'no']);
    expect(bar.segments.find((s) => s.key === 'notVoted')).toBeUndefined();
  });

  it('labels and amountLabel are formatAda on the exact BigInt string', () => {
    const bar = buildFullStakeBar(
      makeInput({
        activeYesPower: 1_000_000,
        activeNoPower: 2_000_000,
        activeAbstainPower: 3_000_000,
        alwaysAbstainPower: '4000000',
        alwaysNoConfidencePower: '5000000',
        reprTotalPower: '10000000',
      }),
    )!;
    const byKey = Object.fromEntries(bar.segments.map((s) => [s.key, s]));
    expect(byKey.yes).toMatchObject({ label: 'Yes', amountLabel: '1 ₳' });
    expect(byKey.no).toMatchObject({ label: 'No', amountLabel: '2 ₳' });
    expect(byKey.activeAbstain).toMatchObject({ label: 'Abstain (active)', amountLabel: '3 ₳' });
    expect(byKey.alwaysAbstain).toMatchObject({ label: 'Always abstain', amountLabel: '4 ₳' });
    expect(byKey.alwaysNoConfidence).toMatchObject({
      label: 'Always no confidence',
      amountLabel: '5 ₳',
    });
    expect(byKey.notVoted).toMatchObject({ label: 'Not voted', amountLabel: '4 ₳' });
    expect(bar.totalLabel).toBe('19 ₳');
  });

  it('computes exact percentages via BigInt arithmetic for amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const bar = buildFullStakeBar(
      makeInput({
        activeYesPower: 4_500_000_000_000_000, // under 2^53, the active-power ceiling
        activeNoPower: null,
        activeAbstainPower: null,
        alwaysAbstainPower: '0',
        alwaysNoConfidencePower: '0',
        reprTotalPower: '9000000000000000000', // 9e18, far beyond 2^53
      }),
    )!;
    expect(bar.segments.map((s) => s.key)).toEqual(['yes', 'notVoted']);
    expect(bar.segments.map((s) => s.pct)).toEqual([0.05, 99.95]);
  });
});
