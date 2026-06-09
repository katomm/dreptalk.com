/// <reference types="@cloudflare/workers-types" />
// checkRate is backed by the RateLimiter Durable Object. These run in real
// workerd via @cloudflare/vitest-pool-workers so the DO's atomic single-threaded
// counting, the window reset, and per-key isolation are exercised end to end.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { checkRate } from './rate.js';

const ns = () => env.RATE_LIMITER;

// Per-test unique keys so persisted DO state never leaks across cases.
let counter = 0;
const uniqueKey = (label: string) => `test-${label}-${++counter}`;

describe('checkRate (Durable Object backed)', () => {
  it('allows requests up to max within a window, then denies', async () => {
    const key = uniqueKey('allow');
    const opts = { max: 3, windowSec: 60, now: 1000 };
    expect(await checkRate(ns(), key, opts)).toBe(true);
    expect(await checkRate(ns(), key, opts)).toBe(true);
    expect(await checkRate(ns(), key, opts)).toBe(true);
    expect(await checkRate(ns(), key, opts)).toBe(false);
  });

  it('opens a fresh window once windowSec has elapsed', async () => {
    const key = uniqueKey('reset');
    const full = { max: 2, windowSec: 60, now: 1000 };
    expect(await checkRate(ns(), key, full)).toBe(true);
    expect(await checkRate(ns(), key, full)).toBe(true);
    expect(await checkRate(ns(), key, full)).toBe(false); // window is full
    // A full window later the counter must reset, not stay blocked forever
    // (the failure mode of the old KV counter that dropped its TTL).
    const later = { max: 2, windowSec: 60, now: 1000 + 60_000 };
    expect(await checkRate(ns(), key, later)).toBe(true);
  });

  it('keeps separate keys independent', async () => {
    const opts = { max: 1, windowSec: 60, now: 1000 };
    const a = uniqueKey('keyA');
    const b = uniqueKey('keyB');
    expect(await checkRate(ns(), a, opts)).toBe(true);
    expect(await checkRate(ns(), b, opts)).toBe(true); // a is at limit, b is fresh
  });

  it('admits exactly max under a concurrent burst (atomic, no TOCTOU overshoot)', async () => {
    const key = uniqueKey('burst');
    const max = 5;
    const opts = { max, windowSec: 60, now: 1000 };
    const results = await Promise.all(
      Array.from({ length: max + 8 }, () => checkRate(ns(), key, opts)),
    );
    expect(results.filter(Boolean).length).toBe(max);
  });
});
