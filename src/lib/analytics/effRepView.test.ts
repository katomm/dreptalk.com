import { describe, it, expect } from 'vitest';
import { buildEffRep } from './effRepView.js';
import type { DecidedActionRepresentation } from '../db/effectiveRepresentation.js';

/** Minimal builder for a decided action, with sane defaults overridden per case. */
function a(
  id: string,
  decidedEpoch: number,
  over: Partial<{
    title: string | null;
    topicSlug: string | null;
    type: string;
    votedPower: number | null;
    votesCast: number;
    totalDrepPower: string | null;
    poweredDrepCount: number | null;
  }> = {},
): DecidedActionRepresentation {
  return {
    id,
    title: `Action ${id}`,
    topicSlug: 'treasury',
    type: 'InfoAction',
    decidedEpoch,
    votedPower: 500,
    votesCast: 100,
    totalDrepPower: '1000',
    poweredDrepCount: 500,
    ...over,
  };
}

describe('buildEffRep', () => {
  it('computes power and count shares for the happy path, skips actions missing votedPower or a stats row', () => {
    const view = buildEffRep([
      a('g1', 540, { votedPower: 640, totalDrepPower: '1000', poweredDrepCount: 800, votesCast: 400 }),
      a('g2', 539, { votedPower: 250, totalDrepPower: '1000', poweredDrepCount: null }),
      a('g3', 538, { votedPower: null }),
      a('g4', 537, { totalDrepPower: null }),
    ]);
    expect(view.rows).toHaveLength(2);
    expect(view.rows[0].powerSharePct).toBe(64);
    expect(view.rows[0].countSharePct).toBe(50);
    expect(view.rows[1].countSharePct).toBeNull();
    expect(view.medianPowerSharePct).toBe(44.5);
    expect(view.skipped).toBe(2);
  });

  it('skips an action whose stats row has a zero totalDrepPower, without dividing by zero', () => {
    const view = buildEffRep([a('g1', 540, { totalDrepPower: '0' })]);
    expect(view.rows).toHaveLength(0);
    expect(view.skipped).toBe(1);
  });

  it('nulls countSharePct when poweredDrepCount is zero, without dividing by zero', () => {
    const view = buildEffRep([a('g1', 540, { poweredDrepCount: 0 })]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].countSharePct).toBeNull();
  });

  it('clamps powerSharePct to 100 when votedPower exceeds the denominator', () => {
    const view = buildEffRep([a('g1', 540, { votedPower: 1500, totalDrepPower: '1000' })]);
    expect(view.rows[0].powerSharePct).toBe(100);
  });

  it('takes the median over an odd number of surviving rows', () => {
    const view = buildEffRep([
      a('g1', 540, { votedPower: 100, totalDrepPower: '1000' }), // 10%
      a('g2', 539, { votedPower: 500, totalDrepPower: '1000' }), // 50%
      a('g3', 538, { votedPower: 900, totalDrepPower: '1000' }), // 90%
    ]);
    expect(view.medianPowerSharePct).toBe(50);
  });

  it('averages the middle two for an even number of surviving rows', () => {
    const view = buildEffRep([
      a('g1', 540, { votedPower: 100, totalDrepPower: '1000' }), // 10%
      a('g2', 539, { votedPower: 300, totalDrepPower: '1000' }), // 30%
      a('g3', 538, { votedPower: 700, totalDrepPower: '1000' }), // 70%
      a('g4', 537, { votedPower: 900, totalDrepPower: '1000' }), // 90%
    ]);
    expect(view.medianPowerSharePct).toBe(50);
  });

  it('returns a null median and no rows for an empty input', () => {
    const view = buildEffRep([]);
    expect(view.rows).toEqual([]);
    expect(view.medianPowerSharePct).toBeNull();
    expect(view.skipped).toBe(0);
  });

  it('builds href from the topic slug, and leaves it null without one', () => {
    const view = buildEffRep([
      a('g1', 540, { topicSlug: 'treasury-withdrawals' }),
      a('g2', 539, { topicSlug: null }),
    ]);
    expect(view.rows[0].href).toBe('/t/treasury-withdrawals/');
    expect(view.rows[1].href).toBeNull();
  });

  it('falls back the title to the action type when the title is null', () => {
    const view = buildEffRep([a('g1', 540, { title: null, type: 'TreasuryWithdrawals' })]);
    expect(view.rows[0].title).toBe('TreasuryWithdrawals');
  });

  it('carries id, type and decidedEpoch through unchanged', () => {
    const view = buildEffRep([a('g1', 540, { type: 'ParameterChange' })]);
    expect(view.rows[0]).toMatchObject({ id: 'g1', type: 'ParameterChange', decidedEpoch: 540 });
  });

  describe('concentration extension', () => {
    it('attaches halfCount from the powers map and computes the median', () => {
      const actions = [
        a('ga1', 540, { votedPower: 100, totalDrepPower: '1000' }),
        a('ga2', 539, { votedPower: 100, totalDrepPower: '1000' }),
      ];
      const powers = new Map([
        ['ga1', [50, 30, 20]],
        ['ga2', [10, 10, 10, 10]],
      ]);
      const view = buildEffRep(actions, powers);
      expect(view.rows[0].halfCount).toBe(1);
      expect(view.rows[0].voterCount).toBe(3);
      expect(view.rows[1].halfCount).toBe(2);
      expect(view.rows[1].voterCount).toBe(4);
      expect(view.medianHalfCount).toBe(1.5);
    });

    it('leaves halfCount null on incomplete power data and excludes it from the median', () => {
      const actions = [
        a('ga1', 540, { votedPower: 100, totalDrepPower: '1000' }),
        a('ga2', 539, { votedPower: 100, totalDrepPower: '1000' }),
      ];
      const powers = new Map([
        ['ga1', [50, null, 20]],
        ['ga2', [10, 10, 10, 10]],
      ]);
      const view = buildEffRep(actions, powers);
      expect(view.rows[0].halfCount).toBeNull();
      expect(view.rows[0].voterCount).toBeNull();
      expect(view.rows[1].halfCount).toBe(2);
      expect(view.medianHalfCount).toBe(2);
    });

    it('keeps working without a powers map', () => {
      const view = buildEffRep([a('ga1', 540)]);
      expect(view.rows[0].halfCount).toBeNull();
      expect(view.rows[0].voterCount).toBeNull();
      expect(view.medianHalfCount).toBeNull();
    });
  });
});
