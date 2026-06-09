/// <reference types="@cloudflare/workers-types" />
// Atomic rate-limit counter as a Durable Object. One instance per rate-limit key
// (routed via idFromName), so a key's read-modify-write is serialized by the DO's
// single-threaded execution: a concurrent burst on one key cannot overshoot the
// limit the way the old non-atomic KV counter could. The window state is
// persisted so it survives hibernation; the decision itself lives in the pure
// decideRate() so it stays unit-testable without the Workers runtime.
import { DurableObject } from 'cloudflare:workers';
import { decideRate, type RateWindow } from './rate.js';

const STATE_KEY = 'w';

export class RateLimiter extends DurableObject {
  /**
   * Records one request against this key's window and returns whether it is
   * allowed. get -> decide -> put runs with no await in between, so it is one
   * atomic step under the DO input gate. Denied requests do not write (next is
   * the unchanged previous state), so a flood costs no extra storage writes.
   */
  async limit(opts: { max: number; windowSec: number; now: number }): Promise<boolean> {
    const prev = (await this.ctx.storage.get<RateWindow>(STATE_KEY)) ?? null;
    const { allowed, next } = decideRate(prev, opts);
    if (next !== prev) {
      await this.ctx.storage.put(STATE_KEY, next);
    }
    return allowed;
  }
}
