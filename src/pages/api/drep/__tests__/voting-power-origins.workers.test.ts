// Endpoint gates plus the cache-hit path (no Koios). The compute path is
// covered by provenanceCompute.workers.test.ts with a fake client, this file
// never exercises a live Koios call, same split as track.workers.test.ts.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { POST } from '../voting-power-origins';
import { putProvenanceCache } from '@/lib/db/provenanceCache';

const DREP_ID = 'drep1originroute';
const USER_ID = 'user-origin-route-1';

function ctx(user: { id: string; roles: string[] } | null, body: unknown, headers: Record<string, string> = {}) {
  const request = new Request('https://dreptalk.com/api/drep/voting-power-origins', {
    method: 'POST',
    headers: { origin: 'https://dreptalk.com', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const locals = { user } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof POST>[0];
}

async function seedDrepUser(id: string, drepId: string) {
  await env.DB.prepare(
    `INSERT INTO users (id, drep_id, stake_addr, is_drep, role, status, created_at, last_verified_at, notif_seen_at)
     VALUES (?, ?, NULL, 1, 'member', 'active', 0, 0, 0)`,
  ).bind(id, drepId).run();
}

describe('POST /api/drep/voting-power-origins', () => {
  it('returns 401 when no session is present', async () => {
    expect((await POST(ctx(null, { window: 12 }))).status).toBe(401);
  });

  it('returns 401 for a session without the drep role', async () => {
    expect((await POST(ctx({ id: USER_ID, roles: ['member'] }, { window: 12 }))).status).toBe(401);
  });

  it('returns 403 for a cross-origin request', async () => {
    const res = await POST(ctx({ id: USER_ID, roles: ['drep'] }, { window: 12 }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
  });

  it('rejects a window outside the whitelist', async () => {
    await seedDrepUser('user-origin-badwin', 'drep1originbadwin');
    expect((await POST(ctx({ id: 'user-origin-badwin', roles: ['drep'] }, { window: 7 }))).status).toBe(400);
  });

  it('serves a fresh cache row without touching Koios', async () => {
    await seedDrepUser(USER_ID, DREP_ID);
    const payload = JSON.stringify({ version: 1, computedAt: Date.now(), windowEpochs: 12, sources: [] });
    await putProvenanceCache(env.DB as D1Database, DREP_ID, 12, payload, Date.now());
    const res = await POST(ctx({ id: USER_ID, roles: ['drep'] }, { window: 12 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { windowEpochs: number }).windowEpochs).toBe(12);
  });

  it('rate-limits repeated calls per account', async () => {
    await seedDrepUser('user-origin-rate', 'drep1originrate');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await POST(ctx({ id: 'user-origin-rate', roles: ['drep'] }, { window: 7 }))).status);
    }
    expect(statuses).toContain(429);
  });
});
