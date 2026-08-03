import { describe, it, expect } from 'vitest';
import {
  evaluateDrepStats,
  parseDrepStatsPayload,
  formatDrepStatsSummary,
  formatDrepStatsDetail,
  type DrepStatsPayload,
} from './drepStats.js';

function candidate(over: Partial<Parameters<typeof evaluateDrepStats>[0]> = {}) {
  return { power: null, powerPrev: null, delegators: null, delegatorsPrev: null, ...over };
}

describe('evaluateDrepStats', () => {
  it('never fires on reward drift below one percent', () => {
    const r = evaluateDrepStats(candidate({ power: '100500000', powerPrev: '100000000' }));
    expect(r.fires).toBe(false);
    expect(r.powerDeltaPct).toBeCloseTo(0.5);
  });

  it('fires at exactly the power threshold, both directions', () => {
    expect(evaluateDrepStats(candidate({ power: '101000000', powerPrev: '100000000' })).fires).toBe(true);
    expect(evaluateDrepStats(candidate({ power: '99000000', powerPrev: '100000000' })).fires).toBe(true);
  });

  it('fires when power appears from a zero previous snapshot', () => {
    const r = evaluateDrepStats(candidate({ power: '5000000', powerPrev: '0' }));
    expect(r.fires).toBe(true);
    expect(r.powerDeltaPct).toBeNull();
  });

  it('skips the power part when the previous snapshot is missing', () => {
    const r = evaluateDrepStats(candidate({ power: '100000000' }));
    expect(r.fires).toBe(false);
    expect(r.powerDeltaPct).toBeNull();
  });

  it('floor beats percent for small DReps: one delegator is enough', () => {
    const r = evaluateDrepStats(candidate({ delegators: 3, delegatorsPrev: 2 }));
    expect(r.fires).toBe(true);
    expect(r.countDelta).toBe(1);
  });

  it('percent beats floor for large DReps: churn below one percent stays quiet', () => {
    expect(evaluateDrepStats(candidate({ delegators: 19005, delegatorsPrev: 19000 })).fires).toBe(false);
    expect(evaluateDrepStats(candidate({ delegators: 19200, delegatorsPrev: 19000 })).fires).toBe(true);
  });

  it('a lost delegator on a small DRep fires too', () => {
    expect(evaluateDrepStats(candidate({ delegators: 1, delegatorsPrev: 2 })).fires).toBe(true);
  });

  it('skips the count part when either side is NULL', () => {
    expect(evaluateDrepStats(candidate({ delegators: 5 })).fires).toBe(false);
    expect(evaluateDrepStats(candidate({ delegatorsPrev: 5 })).fires).toBe(false);
  });

  it('zero previous count uses the floor', () => {
    const r = evaluateDrepStats(candidate({ delegators: 1, delegatorsPrev: 0 }));
    expect(r.fires).toBe(true);
  });

  it('does not fire when nothing is evaluable', () => {
    expect(evaluateDrepStats(candidate()).fires).toBe(false);
  });
});

describe('parseDrepStatsPayload', () => {
  const good: DrepStatsPayload = {
    epoch: 570,
    drepId: 'drep1abc',
    power: '65200000000000',
    powerPrev: '63200000000000',
    delegators: 1540,
    delegatorsPrev: 1528,
  };

  it('round-trips a full payload', () => {
    expect(parseDrepStatsPayload(JSON.stringify(good))).toEqual(good);
  });

  it('tolerates null optional fields', () => {
    const p = { ...good, power: null, delegatorsPrev: null };
    expect(parseDrepStatsPayload(JSON.stringify(p))).toEqual(p);
  });

  it('never throws on garbage', () => {
    expect(parseDrepStatsPayload(null)).toBeNull();
    expect(parseDrepStatsPayload('not json')).toBeNull();
    expect(parseDrepStatsPayload('{}')).toBeNull();
    expect(parseDrepStatsPayload(JSON.stringify({ epoch: 'x', drepId: 5 }))).toBeNull();
  });

  it('rejects wrong optional types instead of coercing them to null', () => {
    expect(parseDrepStatsPayload(JSON.stringify({ epoch: 570, drepId: 'x', delegators: 'many' }))).toBeNull();
    expect(parseDrepStatsPayload(JSON.stringify({ epoch: 570, drepId: 'x', power: 12 }))).toBeNull();
    expect(parseDrepStatsPayload(JSON.stringify({ epoch: 570, drepId: 'x', power: '12.5' }))).toBeNull();
    expect(parseDrepStatsPayload(JSON.stringify({ epoch: 570, drepId: 'x', delegatorsPrev: -1 }))).toBeNull();
    expect(parseDrepStatsPayload(JSON.stringify({ epoch: -1, drepId: 'x' }))).toBeNull();
    expect(parseDrepStatsPayload(JSON.stringify({ epoch: 570.5, drepId: 'x' }))).toBeNull();
    expect(parseDrepStatsPayload(JSON.stringify({ epoch: 570, drepId: '' }))).toBeNull();
  });
});

describe('formatDrepStatsSummary', () => {
  it('shows both values with signed deltas', () => {
    const text = formatDrepStatsSummary({
      epoch: 570,
      drepId: 'drep1abc',
      power: '65200000000000',
      powerPrev: '63200000000000',
      delegators: 1540,
      delegatorsPrev: 1528,
    });
    expect(text).toBe('Epoch 570: voting power 65.2M ₳ (+3.2%), 1,540 delegators (+12)');
  });

  it('omits a delta it cannot compute and singularizes one delegator', () => {
    const text = formatDrepStatsSummary({
      epoch: 571,
      drepId: 'drep1abc',
      power: '5000000',
      powerPrev: null,
      delegators: 1,
      delegatorsPrev: null,
    });
    expect(text).toBe('Epoch 571: voting power 5 ₳, 1 delegator');
  });

  it('marks power appearing from zero as new', () => {
    const text = formatDrepStatsSummary({
      epoch: 572,
      drepId: 'drep1abc',
      power: '5000000',
      powerPrev: '0',
      delegators: null,
      delegatorsPrev: null,
    });
    expect(text).toBe('Epoch 572: voting power 5 ₳ (new)');
  });

  it('does not mark zero-to-zero power as new when the count triggered', () => {
    const text = formatDrepStatsSummary({
      epoch: 574,
      drepId: 'drep1abc',
      power: '0',
      powerPrev: '0',
      delegators: 2,
      delegatorsPrev: 1,
    });
    expect(text).toBe('Epoch 574: voting power 0 ₳, 2 delegators (+1)');
  });

  it('shows a negative count delta', () => {
    const text = formatDrepStatsSummary({
      epoch: 573,
      drepId: 'drep1abc',
      power: null,
      powerPrev: null,
      delegators: 8,
      delegatorsPrev: 10,
    });
    expect(text).toBe('Epoch 573: 8 delegators (-2)');
  });
});

describe('formatDrepStatsDetail', () => {
  it('drops the epoch prefix so the push body can stand alone under the title', () => {
    const p: DrepStatsPayload = {
      epoch: 570,
      drepId: 'drep1abc',
      power: '65200000000000',
      powerPrev: '63200000000000',
      delegators: 1540,
      delegatorsPrev: 1528,
    };
    expect(formatDrepStatsDetail(p)).toBe('voting power 65.2M ₳ (+3.2%), 1,540 delegators (+12)');
    // The summary is exactly the epoch prefix plus this detail.
    expect(formatDrepStatsSummary(p)).toBe(`Epoch ${p.epoch}: ${formatDrepStatsDetail(p)}`);
  });
});
