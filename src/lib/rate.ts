/// <reference types="@cloudflare/workers-types" />
// Fixed-window rate-limit counter stored in KV.
// Each key holds a plain decimal counter string with TTL = windowSec.
// First call in a window sets the key; subsequent calls increment it.
// Returns true (allowed) if count was below max before increment,
// false (denied) if already at or above max.

/**
 * Checks and increments a rate-limit counter in KV.
 *
 * @param kv - KV namespace to store counters in.
 * @param key - Logical key (e.g. "topic:user-id"). Stored internally as "rate:<key>".
 * @param opts.max - Maximum allowed requests per window.
 * @param opts.windowSec - Window length in seconds (used as KV TTL on first write).
 * @param opts.now - Current time in ms (accepted for testability, not used in logic).
 * @returns true if the request is allowed, false if the limit is exceeded.
 */
export async function checkRate(
  kv: KVNamespace,
  key: string,
  opts: { max: number; windowSec: number; now: number },
): Promise<boolean> {
  const { max, windowSec } = opts;
  const kvKey = `rate:${key}`;

  const existing = await kv.get(kvKey);
  const current = existing === null ? 0 : parseInt(existing, 10);

  if (current >= max) {
    return false;
  }

  await kv.put(kvKey, String(current + 1), { expirationTtl: windowSec });
  return true;
}
