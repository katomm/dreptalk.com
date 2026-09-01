import { describe, it, expect } from 'vitest';
import { buildBodyStake, type BodyStakeInput } from './fullStakeView.js';

function makeInput(overrides: Partial<BodyStakeInput> = {}): BodyStakeInput {
  return {
    actionType: 'ParameterChange',
    activeYesPower: 10,
    activeNoPower: 0,
    activeAbstainPower: 0,
    noSidePower: '90',
    alwaysAbstainPower: '0',
    alwaysNoConfidencePower: '0',
    approvalThresholdPct: null,
    ...overrides,
  };
}

// Real mainnet snapshot of the "Update Constitutional Committee 2026" NewCommittee
// action (gov_action1w2w64…, epoch 652), straight from Koios
// proposal_voting_summary. Both bodies are checked against the two independent
// explorers that render this action, so a regression here shows up as a
// disagreement with the rest of the ecosystem rather than as an internal test edit.
const MAINNET_NEW_COMMITTEE = {
  drep: {
    actionType: 'NewCommittee',
    activeYesPower: 3_495_040_778_691_676,
    activeNoPower: 14_080_895_011_611,
    activeAbstainPower: 23_769_302_134_251,
    noSidePower: '1587872967435543',
    alwaysAbstainPower: '9776721978688292',
    alwaysNoConfidencePower: '150047859757520',
    approvalThresholdPct: 67,
  } satisfies BodyStakeInput,
  spo: {
    actionType: 'NewCommittee',
    activeYesPower: 5_566_247_741_885_681,
    activeNoPower: 2_007_788_303_239,
    activeAbstainPower: 492_792_127_920_271,
    noSidePower: '5322837822257538',
    alwaysAbstainPower: '9991941509557618',
    alwaysNoConfidencePower: '52030156128297',
    approvalThresholdPct: 51,
  } satisfies BodyStakeInput,
};

const pctOf = (v: ReturnType<typeof buildBodyStake>, key: string): number =>
  v!.segments.find((s) => s.key === key)?.pct ?? 0;

describe('buildBodyStake', () => {
  describe('progressive enhancement', () => {
    it('returns null when noSidePower is missing', () => {
      expect(buildBodyStake(makeInput({ noSidePower: null }))).toBeNull();
    });

    it('returns null when alwaysAbstainPower is missing', () => {
      expect(buildBodyStake(makeInput({ alwaysAbstainPower: null }))).toBeNull();
    });

    it('returns null when alwaysNoConfidencePower is missing', () => {
      expect(buildBodyStake(makeInput({ alwaysNoConfidencePower: null }))).toBeNull();
    });

    it('returns null when none of the three active powers is present', () => {
      expect(
        buildBodyStake(makeInput({ activeYesPower: null, activeNoPower: null, activeAbstainPower: null })),
      ).toBeNull();
    });

    it('returns null on a malformed stored lovelace string rather than throwing', () => {
      expect(buildBodyStake(makeInput({ noSidePower: 'not-a-number' }))).toBeNull();
    });

    it('returns null for NoConfidence, where the always-no-confidence side is unverified', () => {
      expect(buildBodyStake(makeInput({ actionType: 'NoConfidence' }))).toBeNull();
    });

    it('proceeds when only one of the three active powers is present', () => {
      expect(
        buildBodyStake(makeInput({ activeNoPower: null, activeAbstainPower: null })),
      ).not.toBeNull();
    });
  });

  describe('mainnet NewCommittee, DRep body', () => {
    const view = buildBodyStake(MAINNET_NEW_COMMITTEE.drep)!;

    it('reproduces the yes share Koios reports (68.76%) off the counted denominator', () => {
      const counted = 3_495_040_778_691_676n + 1_587_872_967_435_543n;
      expect(Number((3_495_040_778_691_676n * 1_000_000n) / counted) / 10_000).toBeCloseTo(68.76, 2);
      expect(view.countedLabel).toBe('5.08B ₳');
    });

    it('totals every eligible lovelace, matching Cardanoscan DRep total stake', () => {
      expect(view.totalLabel).toBe('14.88B ₳');
      expect(view.excludedLabel).toBe('9.8B ₳');
    });

    it('turnout is cast stake over the full stake, well below the counted-based share', () => {
      expect(view.turnoutPct).toBeCloseTo(23.74, 1);
    });

    it('splits the No side into cast No, always-no-confidence and the default No', () => {
      // Cardanoscan renders exactly these three rows: 14.02m, 145.86m, 1.43b.
      expect(view.segments.find((s) => s.key === 'no')!.amountLabel).toBe('14.08M ₳');
      expect(view.segments.find((s) => s.key === 'alwaysNoConfidence')!.amountLabel).toBe('150.05M ₳');
      expect(view.segments.find((s) => s.key === 'defaultNo')!.amountLabel).toBe('1.42B ₳');
    });

    it('marks the abstain segments as outside the tally and the rest as counted', () => {
      const counted = Object.fromEntries(view.segments.map((s) => [s.key, s.counted]));
      expect(counted).toEqual({
        yes: true,
        no: true,
        defaultNo: true,
        alwaysNoConfidence: true,
        activeAbstain: false,
        alwaysAbstain: false,
      });
    });
  });

  describe('mainnet NewCommittee, SPO body', () => {
    const view = buildBodyStake(MAINNET_NEW_COMMITTEE.spo)!;

    it('totals 21.37B ada, the figure adastats shows, not the 21.43B of the old double count', () => {
      expect(view.totalLabel).toBe('21.37B ₳');
    });

    it('counts only half the eligible stake, which is why 51% yes sits next to 28% turnout', () => {
      expect(view.countedLabel).toBe('10.89B ₳');
      expect(view.countedSharePct).toBeCloseTo(50.95, 1);
      expect(view.turnoutPct).toBeCloseTo(28.36, 1);
      // The reading the old card made impossible: yes is a hair over half the
      // counted stake, and barely a quarter of the stake that exists. BigInt because
      // the counted denominator is past Number's safe range.
      const countedLovelace = 5_566_247_741_885_681n + 5_322_837_822_257_538n;
      const yesOfCounted = Number((5_566_247_741_885_681n * 1_000_000n) / countedLovelace) / 10_000;
      expect(yesOfCounted).toBeCloseTo(51.12, 2);
      expect(pctOf(view, 'yes')).toBeCloseTo(26.04, 1);
    });

    it('shows the 5.27B ada that never voted and still counts as no', () => {
      expect(view.segments.find((s) => s.key === 'defaultNo')!.amountLabel).toBe('5.27B ₳');
      expect(view.segments.find((s) => s.key === 'alwaysAbstain')!.amountLabel).toBe('9.99B ₳');
    });

    it('segment shares sum to 100% of the full stake', () => {
      const sum = view.segments.reduce((t, s) => t + s.pct, 0);
      expect(sum).toBeCloseTo(100, 2);
    });
  });

  describe('edge cases', () => {
    it('clamps the default No to zero when a snapshot reports a No side below its own parts', () => {
      const view = buildBodyStake(
        makeInput({ activeNoPower: 80, noSidePower: '50', alwaysNoConfidencePower: '10' }),
      )!;
      expect(view.segments.find((s) => s.key === 'defaultNo')).toBeUndefined();
    });

    it('returns null when the body holds no stake at all', () => {
      expect(
        buildBodyStake(makeInput({ activeYesPower: 0, noSidePower: '0', alwaysAbstainPower: '0' })),
      ).toBeNull();
    });

    it('drops empty segments so the bar carries no zero-width slivers', () => {
      const view = buildBodyStake(makeInput({ activeYesPower: 10, noSidePower: '90' }))!;
      expect(view.segments.map((s) => s.key)).toEqual(['yes', 'defaultNo']);
    });
  });
});
