import { describe, it, expect } from 'vitest';
import { buildBodyStake, bucketsDrifted, bucketsReproduceTally, ratificationYesPct, shownYesPct, type BodyStakeInput } from './fullStakeView.js';

function makeInput(overrides: Partial<BodyStakeInput> = {}): BodyStakeInput {
  return {
    actionType: 'ParameterChange',
    body: 'DRep',
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
    body: 'DRep',
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
    body: 'SPO',
    activeYesPower: 5_566_247_741_885_681,
    activeNoPower: 2_007_788_303_239,
    activeAbstainPower: 492_792_127_920_271,
    noSidePower: '5322837822257538',
    alwaysAbstainPower: '9991941509557618',
    alwaysNoConfidencePower: '52030156128297',
    approvalThresholdPct: 51,
  } satisfies BodyStakeInput,
};

// The SPO side of the van Rossem hard fork (gov_action1lh2x3…, ratified epoch 643),
// as stored on mainnet. yes + no side + voted abstain is 21.40B of the epoch's 21.41B
// active stake, so the 4.33B always-abstain bucket is already inside the no side.
const MAINNET_VAN_ROSSEM_SPO = {
  actionType: 'HardForkInitiation',
  body: 'SPO',
  activeYesPower: 10_445_177_677_947_930,
  activeNoPower: 0,
  activeAbstainPower: 1_699_130_913_945_099,
  noSidePower: '9254034669953667',
  alwaysAbstainPower: '4329479686219479',
  alwaysNoConfidencePower: '52023987145075',
  approvalThresholdPct: 51,
} satisfies BodyStakeInput;

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

    it('keeps always-abstain outside the tally on a non hard fork action', () => {
      expect(view.segments.find((s) => s.key === 'alwaysAbstain')!.counted).toBe(false);
    });
  });

  describe('mainnet van Rossem hard fork, SPO body', () => {
    const view = buildBodyStake(MAINNET_VAN_ROSSEM_SPO)!;

    it('counts yes and the no side, which reproduces the 53.02% Koios reports', () => {
      expect(view.countedLabel).toBe('19.7B ₳');
      const counted = 10_445_177_677_947_930n + 9_254_034_669_953_667n;
      expect(Number((10_445_177_677_947_930n * 1_000_000n) / counted) / 10_000).toBeCloseTo(53.02, 2);
    });

    it('totals the epoch active stake, with the always-abstain bucket counted once', () => {
      // 21.40B, the epoch's active stake. Summing the bucket on top would give 25.73B.
      expect(view.totalLabel).toBe('21.4B ₳');
      expect(view.excludedLabel).toBe('1.7B ₳');
      expect(view.countedSharePct).toBeCloseTo(92.06, 1);
      expect(view.turnoutPct).toBeCloseTo(56.75, 1);
    });

    it('shows always-abstain as counted No, split out of the default No', () => {
      const aa = view.segments.find((s) => s.key === 'alwaysAbstain')!;
      expect(aa).toMatchObject({ counted: true, amountLabel: '4.33B ₳', label: 'Always abstain, counted as No' });
      // 9.25B no side minus 4.33B always-abstain minus 52.02M always-no-confidence.
      expect(view.segments.find((s) => s.key === 'defaultNo')!.amountLabel).toBe('4.87B ₳');
    });

    it('keeps the counted segments contiguous from the left, voted abstain last', () => {
      expect(view.segments.map((s) => [s.key, s.counted])).toEqual([
        ['yes', true],
        ['defaultNo', true],
        ['alwaysNoConfidence', true],
        ['alwaysAbstain', true],
        ['activeAbstain', false],
      ]);
      const countedSum = view.segments.filter((s) => s.counted).reduce((t, s) => t + s.pct, 0);
      expect(countedSum).toBeCloseTo(view.countedSharePct, 2);
    });

    it('segment shares sum to 100% of the full stake', () => {
      const sum = view.segments.reduce((t, s) => t + s.pct, 0);
      expect(sum).toBeCloseTo(100, 2);
    });

    it('leaves the DRep side of a hard fork on the default rule', () => {
      const drep = buildBodyStake({ ...MAINNET_VAN_ROSSEM_SPO, body: 'DRep' })!;
      expect(drep.segments.find((s) => s.key === 'alwaysAbstain')).toMatchObject({
        counted: false,
        label: 'Always abstain',
      });
      expect(drep.excludedLabel).toBe('6.03B ₳');
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

describe('ratificationYesPct and the tally consistency gate', () => {
  // Update Constitutional Committee 2026, SPO side as stored on mainnet: the buckets
  // and the frozen 56.15 come from the same snapshot.
  const ccUpdate = { yesPower: 6190687758990589, noSidePower: '4834832027344520' };

  it('derives the four-decimal share from yes and the no side', () => {
    expect(ratificationYesPct({ actionType: 'NewCommittee', body: 'SPO', ...ccUpdate })).toBe(56.1487);
  });

  it('declines NoConfidence and missing columns', () => {
    expect(ratificationYesPct({ actionType: 'NoConfidence', body: 'DRep', ...ccUpdate })).toBeNull();
    expect(ratificationYesPct({ actionType: 'HardForkInitiation', body: 'DRep', ...ccUpdate })).toBe(56.1487);
    expect(ratificationYesPct({ actionType: 'InfoAction', body: 'SPO', yesPower: null, noSidePower: '1' })).toBeNull();
    expect(ratificationYesPct({ actionType: 'InfoAction', body: 'SPO', yesPower: 1, noSidePower: 'x' })).toBeNull();
  });

  it('reads the SPO side of a hard fork off the no side, which already holds always-abstain', () => {
    const vanRossem = {
      actionType: 'HardForkInitiation',
      body: 'SPO' as const,
      yesPower: MAINNET_VAN_ROSSEM_SPO.activeYesPower,
      noSidePower: MAINNET_VAN_ROSSEM_SPO.noSidePower,
    };
    expect(ratificationYesPct(vanRossem)).toBe(53.0233);
    // Both stored mainnet hard forks were frozen from an earlier snapshot than their
    // buckets (52.4 vs 53.02, Plomin 65.99 vs 65.03), so the gate drops the buckets.
    expect(bucketsDrifted({ ...vanRossem, storedPct: 52.4 })).toBe(true);
    const plomin = {
      actionType: 'HardForkInitiation',
      body: 'SPO' as const,
      yesPower: 13608245232045680,
      noSidePower: '7316382819243798',
    };
    expect(ratificationYesPct(plomin)).toBeCloseTo(65.03, 2);
    expect(bucketsDrifted({ ...plomin, storedPct: 65.99 })).toBe(true);
  });

  it('refines the stored share only when the buckets reproduce it', () => {
    const body = { actionType: 'NewCommittee', body: 'SPO' as const, ...ccUpdate };
    // Same snapshot: 56.1487 rounds back to 56.15, so it reads 56.1 and never 56.2.
    expect(shownYesPct({ ...body, storedPct: 56.15 })).toBe(56.1487);
    expect(bucketsDrifted({ ...body, storedPct: 56.15 })).toBe(false);
    // Buckets from a later ledger state than the frozen tally: the stored share stays.
    expect(shownYesPct({ ...body, storedPct: 57.16 })).toBe(57.16);
    expect(bucketsDrifted({ ...body, storedPct: 57.16 })).toBe(true);
    expect(bucketsReproduceTally(8.97, 8.9408)).toBe(false);
    // Missing buckets or a missing tally never count as drift.
    expect(bucketsDrifted({ ...body, storedPct: 57.16, noSidePower: null })).toBe(false);
    expect(bucketsDrifted({ ...body, storedPct: null })).toBe(false);
    expect(shownYesPct({ ...body, storedPct: null })).toBeNull();
  });
});
