/// <reference types="@cloudflare/workers-types" />
// Fixed-window rate limiter. The decision is a pure function (decideRate) and the
// counting is atomic: checkRate routes each key to its RateLimiter Durable Object,
// whose single-threaded read-modify-write cannot be raced. This replaces the old
// KV counter, which was non-atomic and (worse) dropped its TTL on the first
// increment, so a key that hit its limit once stayed blocked forever.

// Type-only import (no runtime cycle): rateLimiterDO imports decideRate from here.
import type { RateLimiter } from './rateLimiterDO.js';

export interface RateWindow {
  start: number;
  count: number;
}

/**
 * Pure fixed-window decision: given the previous window state (or null) and the
 * limit options, returns whether the request is allowed and the window state to
 * persist. A new window opens on the first request or once windowSec has fully
 * elapsed, so the counter always resets (the bug the KV version never fixed).
 */
export function decideRate(
  prev: RateWindow | null,
  opts: { max: number; windowSec: number; now: number },
): { allowed: boolean; next: RateWindow } {
  const { max, windowSec, now } = opts;
  if (max < 1) {
    return { allowed: false, next: prev ?? { start: now, count: 0 } };
  }
  if (prev === null || now - prev.start >= windowSec * 1000) {
    return { allowed: true, next: { start: now, count: 1 } };
  }
  if (prev.count >= max) {
    return { allowed: false, next: prev };
  }
  return { allowed: true, next: { start: prev.start, count: prev.count + 1 } };
}

/**
 * Records one request against a rate-limit key and returns whether it is allowed.
 * Each key maps to a dedicated RateLimiter Durable Object instance, so the
 * count is incremented atomically and a concurrent burst cannot exceed max.
 *
 * @param ns - The RATE_LIMITER Durable Object namespace.
 * @param key - Logical key (e.g. "topic:user-id"); the DO instance is "rate:<key>".
 * @param opts.max - Maximum allowed requests per window.
 * @param opts.windowSec - Window length in seconds.
 * @param opts.now - Current time in ms (the window clock; passed by the caller).
 * @returns true if the request is allowed, false if the limit is exceeded.
 */
export async function checkRate(
  ns: DurableObjectNamespace<RateLimiter>,
  key: string,
  opts: { max: number; windowSec: number; now: number },
): Promise<boolean> {
  const stub = ns.get(ns.idFromName(`rate:${key}`));
  return stub.limit(opts);
}

/**
 * Reads a rate-limit key without counting a request against it. Use when only
 * part of an endpoint's traffic should be charged (so checkRate would punish
 * legitimate callers), but a caller already over the limit should be rejected
 * before any expensive work is done.
 *
 * @returns true if a request would currently be allowed, false if the key is over its limit.
 */
export async function peekRate(
  ns: DurableObjectNamespace<RateLimiter>,
  key: string,
  opts: { max: number; windowSec: number; now: number },
): Promise<boolean> {
  const stub = ns.get(ns.idFromName(`rate:${key}`));
  return stub.peek(opts);
}
