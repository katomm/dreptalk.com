import { describe, it, expect } from 'vitest';
import { buildMyDrep, defaultOptionEffect, buildDefaultOptionView } from './myDrepView.js';
import type { SinceActionRow } from '../db/myDrep.js';

function action(gaId: string, opts: Partial<SinceActionRow> = {}): SinceActionRow {
  return {
    gaId,
    title: `Title ${gaId}`,
    topicSlug: null,
    type: 'InfoAction',
    decidedEpoch: 645,
    status: 'enacted',
    vote: 'Yes',
    hasRationale: false,
    ...opts,
  };
}

// 2026-01-15T00:00:00Z, the start of the delegation epoch in the tests below.
const SINCE_START_MS = Date.UTC(2026, 0, 15);

describe('buildMyDrep', () => {
  it('computes participation, rationale coverage, power and delegators from concrete rows', () => {
    const view = buildMyDrep({
      sinceEpoch: 640,
      sinceStartMs: SINCE_START_MS,
      actions: [
        action('ga_1', { decidedEpoch: 648, hasRationale: true }),
        action('ga_2', { decidedEpoch: 647, hasRationale: true }),
        action('ga_3', { decidedEpoch: 646, vote: 'No' }),
        action('ga_4', { decidedEpoch: 645, vote: 'Abstain' }),
        action('ga_5', { decidedEpoch: 644, vote: null, title: null, type: 'ParameterChange' }),
      ],
      voteChanges: 2,
      powerThen: { epoch: 640, amount: '1000000000000', delegatorCount: 12 },
      powerNow: { epoch: 650, amount: '1500000000000', delegatorCount: 20 },
    });

    expect(view.sinceEpoch).toBe(640);
    expect(view.sinceDateIso).toBe('2026-01-15');

    expect(view.eligible).toBe(5);
    expect(view.voted).toBe(4);
    expect(view.participationPct).toBe(80);
    expect(view.missed.map((m) => m.gaId)).toEqual(['ga_5']);

    expect(view.withRationale).toBe(2);
    expect(view.rationalePct).toBe(50);

    expect(view.voteChanges).toBe(2);

    expect(view.power.start).toEqual({ epoch: 640, label: '1M ₳', firstOnRecord: false });
    expect(view.power.now).toEqual({ epoch: 650, label: '1.5M ₳' });
    expect(view.power.deltaLabel).toBe('+500K ₳');

    expect(view.delegators.start).toBe(12);
    expect(view.delegators.now).toBe(20);
    expect(view.delegators.delta).toBe(8);
  });

  it('marks the then-figure as the first on record when its epoch is later than the start', () => {
    const view = buildMyDrep({
      sinceEpoch: 640,
      sinceStartMs: SINCE_START_MS,
      actions: [],
      voteChanges: 0,
      powerThen: { epoch: 645, amount: '1000000000000', delegatorCount: null },
      powerNow: { epoch: 650, amount: '750000000000', delegatorCount: 5 },
    });

    expect(view.power.start).toEqual({ epoch: 645, label: '1M ₳', firstOnRecord: true });
    expect(view.power.deltaLabel).toBe('-250K ₳');
    // A missing start count is never 0, and without both sides there is no delta.
    expect(view.delegators.start).toBeNull();
    expect(view.delegators.now).toBe(5);
    expect(view.delegators.delta).toBeNull();
  });

  it('labels an unchanged power as 0 rather than hiding it', () => {
    const view = buildMyDrep({
      sinceEpoch: 640,
      sinceStartMs: SINCE_START_MS,
      actions: [],
      voteChanges: 0,
      powerThen: { epoch: 640, amount: '1000000000000', delegatorCount: 7 },
      powerNow: { epoch: 641, amount: '1000000000000', delegatorCount: 7 },
    });

    expect(view.power.deltaLabel).toBe('0 ₳');
    expect(view.delegators.start).toBe(7);
    expect(view.delegators.now).toBe(7);
    expect(view.delegators.delta).toBe(0);
  });

  it('leaves the percentages null on an empty basis and the power null when no snapshot exists', () => {
    const view = buildMyDrep({
      sinceEpoch: 640,
      sinceStartMs: SINCE_START_MS,
      actions: [],
      voteChanges: 0,
      powerThen: null,
      powerNow: null,
    });

    expect(view.eligible).toBe(0);
    expect(view.voted).toBe(0);
    expect(view.participationPct).toBeNull();
    expect(view.withRationale).toBe(0);
    expect(view.rationalePct).toBeNull();
    expect(view.missed).toEqual([]);
    expect(view.power.start).toBeNull();
    expect(view.power.now).toBeNull();
    expect(view.power.deltaLabel).toBeNull();
    expect(view.delegators.start).toBeNull();
    expect(view.delegators.now).toBeNull();
    expect(view.delegators.delta).toBeNull();
  });

  it('leaves the rationale percentage null when the DRep voted on nothing in the window', () => {
    const view = buildMyDrep({
      sinceEpoch: 640,
      sinceStartMs: SINCE_START_MS,
      actions: [action('ga_1', { vote: null }), action('ga_2', { vote: null })],
      voteChanges: 0,
      powerThen: null,
      powerNow: null,
    });

    expect(view.eligible).toBe(2);
    expect(view.voted).toBe(0);
    expect(view.participationPct).toBe(0);
    expect(view.rationalePct).toBeNull();
    expect(view.missed.map((m) => m.gaId)).toEqual(['ga_1', 'ga_2']);
  });

  it('does not credit a rationale on an action the DRep never voted on', () => {
    const view = buildMyDrep({
      sinceEpoch: 640,
      sinceStartMs: SINCE_START_MS,
      actions: [action('ga_1', { vote: null, hasRationale: true }), action('ga_2', { vote: 'Yes', hasRationale: true })],
      voteChanges: 0,
      powerThen: null,
      powerNow: null,
    });

    expect(view.withRationale).toBe(1);
    expect(view.rationalePct).toBe(100);
  });

  it('drops a power figure whose amount is not a number rather than showing a zero', () => {
    const view = buildMyDrep({
      sinceEpoch: 640,
      sinceStartMs: SINCE_START_MS,
      actions: [],
      voteChanges: 0,
      powerThen: { epoch: 640, amount: '', delegatorCount: 3 },
      powerNow: { epoch: 650, amount: '1000000000000', delegatorCount: 4 },
    });

    expect(view.power.start).toBeNull();
    expect(view.power.now).toEqual({ epoch: 650, label: '1M ₳' });
    expect(view.power.deltaLabel).toBeNull();
    // The delegator counts are stored beside the amount and stay readable.
    expect(view.delegators.start).toBe(3);
    expect(view.delegators.now).toBe(4);
    expect(view.delegators.delta).toBe(1);
  });
});

describe('defaultOptionEffect', () => {
  it('leaves an always-abstain stake out of the threshold on every type', () => {
    expect(defaultOptionEffect('abstain', 'InfoAction')).toBe(
      'Your stake was left out of the threshold on this action',
    );
    expect(defaultOptionEffect('abstain', 'NoConfidence')).toBe(
      'Your stake was left out of the threshold on this action',
    );
  });

  it('counts an always-no-confidence stake as yes on a no-confidence action', () => {
    expect(defaultOptionEffect('no_confidence', 'NoConfidence')).toBe('Your stake counted as Yes');
  });

  it('counts an always-no-confidence stake as no on every other type', () => {
    expect(defaultOptionEffect('no_confidence', 'InfoAction')).toBe('Your stake counted as No');
    expect(defaultOptionEffect('no_confidence', 'TreasuryWithdrawals')).toBe('Your stake counted as No');
  });
});

describe('buildDefaultOptionView', () => {
  const rows = [
    { gaId: 'ga_a', title: 'Budget 2026', topicSlug: 'budget-2026', type: 'TreasuryWithdrawals', status: 'enacted', decidedEpoch: 650 },
    { gaId: 'ga_b', title: null, topicSlug: null, type: 'NoConfidence', status: 'expired', decidedEpoch: 649 },
    { gaId: 'ga_c', title: 'An info action', topicSlug: null, type: 'InfoAction', status: 'closed', decidedEpoch: 648 },
  ];

  it('states the always-abstain rule once and repeats only the effect per row', () => {
    const view = buildDefaultOptionView('abstain', rows);

    expect(view.rule).toBe(
      'An always-abstain delegation is counted as abstaining on every governance action, so your stake stays out of the yes and no sides and out of the threshold.',
    );
    expect(view.rows).toEqual([
      {
        gaId: 'ga_a',
        title: 'Budget 2026',
        href: '/t/budget-2026/',
        type: 'TreasuryWithdrawals',
        outcome: 'Enacted',
        effect: 'Your stake was left out of the threshold on this action',
      },
      {
        gaId: 'ga_b',
        title: 'No Confidence',
        href: null,
        type: 'NoConfidence',
        outcome: 'Expired',
        effect: 'Your stake was left out of the threshold on this action',
      },
      {
        gaId: 'ga_c',
        title: 'An info action',
        href: null,
        type: 'InfoAction',
        outcome: 'Closed',
        effect: 'Your stake was left out of the threshold on this action',
      },
    ]);
  });

  it('splits the always-no-confidence effect by action type', () => {
    const view = buildDefaultOptionView('no_confidence', rows);

    expect(view.rule).toBe(
      'An always-no-confidence delegation is counted as yes on a no-confidence action and as no on every other type.',
    );
    expect(view.rows.map((r) => r.effect)).toEqual([
      'Your stake counted as No',
      'Your stake counted as Yes',
      'Your stake counted as No',
    ]);
    expect(view.rows.map((r) => r.title)).toEqual(['Budget 2026', 'No Confidence', 'An info action']);
  });

  it('returns no rows when nothing has been decided yet', () => {
    expect(buildDefaultOptionView('abstain', []).rows).toEqual([]);
  });
});
