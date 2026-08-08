import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSession, getSession } from './session.js';
import { SLIDING_WINDOW_SEC } from './timing.js';

const KV = () => env.SESSIONS as KVNamespace;

describe('session activity hooks', () => {
  it('fires onCreate once with the user id at mint', async () => {
    const seen: string[] = [];
    await createSession(KV(), { id: 'uA', roles: ['member'] }, { onCreate: (id) => seen.push(id) });
    expect(seen).toEqual(['uA']);
  });

  it('a throwing onCreate never fails session creation', async () => {
    const token = await createSession(KV(), { id: 'uB', roles: ['member'] }, { onCreate: () => { throw new Error('boom'); } });
    expect(typeof token).toBe('string');
    expect(await getSession(KV(), token)).not.toBeNull();
  });

  it('onRenew fires only after the sliding window, and a throw never nulls the session', async () => {
    const now = 1_000_000; // seconds
    const token = await createSession(KV(), { id: 'uC', roles: ['member'] }, { now });
    const renews: string[] = [];
    await getSession(KV(), token, { now: now + SLIDING_WINDOW_SEC - 1, onRenew: (id) => renews.push(id) });
    expect(renews).toEqual([]); // inside the window: no renew
    const rec = await getSession(KV(), token, { now: now + SLIDING_WINDOW_SEC + 1, onRenew: () => { throw new Error('boom'); } });
    expect(rec).not.toBeNull(); // past the window: throwing callback still returns the record
    const rec2 = await getSession(KV(), token, { now: now + 2 * SLIDING_WINDOW_SEC + 2, onRenew: (id) => renews.push(id) });
    expect(rec2).not.toBeNull();
    expect(renews).toEqual(['uC']);
  });
});
