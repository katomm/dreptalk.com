/// <reference types="@cloudflare/workers-types" />
// Rate-limit helper tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Uses the real NONCES KV binding so TTL semantics are exercised.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { checkRate } from './rate.js';

const kv = () => env.NONCES;

// Use a per-file unique prefix to avoid key collisions across test runs.
let counter = 0;
const uniqueKey = (label: string) => `test-${label}-${Date.now()}-${++counter}`;

describe('checkRate', () => {
  it('allows requests up to max within a window', async () => {
    const key = uniqueKey('allow');
    const opts = { max: 3, windowSec: 60, now: Date.now() };

    expect(await checkRate(kv(), key, opts)).toBe(true);
    expect(await checkRate(kv(), key, opts)).toBe(true);
    expect(await checkRate(kv(), key, opts)).toBe(true);
  });

  it('denies the request at max+1 within the same window', async () => {
    const key = uniqueKey('deny');
    const opts = { max: 3, windowSec: 60, now: Date.now() };

    await checkRate(kv(), key, opts);
    await checkRate(kv(), key, opts);
    await checkRate(kv(), key, opts);

    const denied = await checkRate(kv(), key, opts);
    expect(denied).toBe(false);
  });

  it('allows exactly max=1 request and denies the second', async () => {
    const key = uniqueKey('max1');
    const opts = { max: 1, windowSec: 60, now: Date.now() };

    expect(await checkRate(kv(), key, opts)).toBe(true);
    expect(await checkRate(kv(), key, opts)).toBe(false);
  });

  it('uses a different key namespace (no cross-key leakage)', async () => {
    const opts = { max: 1, windowSec: 60, now: Date.now() };
    const keyA = uniqueKey('keyA');
    const keyB = uniqueKey('keyB');

    expect(await checkRate(kv(), keyA, opts)).toBe(true);
    // keyA is now at limit, but keyB is fresh.
    expect(await checkRate(kv(), keyB, opts)).toBe(true);
  });
});
