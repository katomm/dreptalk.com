// Pure fixed-window decision logic behind the rate limiter. Kept separate from
// the Durable Object so the windowing rules (including the reset that the old KV
// counter never performed) are exercised without the Workers runtime.
import { describe, it, expect } from 'vitest';
import { decideRate } from './rate.js';

describe('decideRate', () => {
  it('allows the first request and opens a window with count 1', () => {
    const r = decideRate(null, { max: 3, windowSec: 60, now: 1000 });
    expect(r).toEqual({ allowed: true, next: { start: 1000, count: 1 } });
  });

  it('increments the count while under the limit in the same window', () => {
    const r = decideRate({ start: 1000, count: 1 }, { max: 3, windowSec: 60, now: 5000 });
    expect(r).toEqual({ allowed: true, next: { start: 1000, count: 2 } });
  });

  it('denies once the count has reached the limit, leaving the window unchanged', () => {
    const r = decideRate({ start: 1000, count: 3 }, { max: 3, windowSec: 60, now: 5000 });
    expect(r).toEqual({ allowed: false, next: { start: 1000, count: 3 } });
  });

  it('opens a fresh window once windowSec has elapsed (the reset the KV counter never did)', () => {
    // Previously at the limit, but a full window has passed: must reset, not stay blocked.
    const r = decideRate({ start: 1000, count: 3 }, { max: 3, windowSec: 60, now: 1000 + 60_000 });
    expect(r).toEqual({ allowed: true, next: { start: 61_000, count: 1 } });
  });

  it('treats a non-positive max as always denied', () => {
    const r = decideRate(null, { max: 0, windowSec: 60, now: 1000 });
    expect(r.allowed).toBe(false);
  });
});
