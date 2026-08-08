import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { bumpLastSeen } from './users.js';
import { SESSION_ACTIVITY_THROTTLE_MS } from '../auth/timing.js';

const NOW = 1_700_000_000_000;

async function seedUser(id: string, lastSeen: number | null) {
  await env.DB.prepare(
    `INSERT INTO users (id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at, last_seen)
     VALUES (?, 0, 0, 0, 0, 'member', 'active', 0, 0, ?)`,
  ).bind(id, lastSeen).run();
}
async function readLastSeen(id: string) {
  return (await env.DB.prepare('SELECT last_seen AS v FROM users WHERE id = ?').bind(id).first<{ v: number | null }>())?.v ?? null;
}

describe('bumpLastSeen', () => {
  beforeEach(async () => { await env.DB.exec('DELETE FROM users'); });

  it('sets last_seen when NULL', async () => {
    await seedUser('u1', null);
    await bumpLastSeen(env.DB, 'u1', NOW);
    expect(await readLastSeen('u1')).toBe(NOW);
  });

  it('overwrites a stale value (older than the throttle window)', async () => {
    await seedUser('u2', NOW - SESSION_ACTIVITY_THROTTLE_MS - 1);
    await bumpLastSeen(env.DB, 'u2', NOW);
    expect(await readLastSeen('u2')).toBe(NOW);
  });

  it('skips a fresh value (inside the window), enforcing one write per user per window', async () => {
    const fresh = NOW - 1000;
    await seedUser('u3', fresh);
    await bumpLastSeen(env.DB, 'u3', NOW);
    expect(await readLastSeen('u3')).toBe(fresh);
  });
});
