/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/vote/liveness.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { POST } from './liveness';

const NOW = 1_752_000_000;
const GA_ACTIVE = `${'a'.repeat(64)}#0`;
const GA_EXPIRED = `${'d'.repeat(64)}#0`;
const GA_UNKNOWN = `${'e'.repeat(64)}#0`;

async function seedActions() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO governance_actions (id, type, title, status, created_at, last_synced_at)
     VALUES (?, 'InfoAction', 'Active Action', 'active', ?, ?)`,
  ).bind(GA_ACTIVE, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO governance_actions (id, type, title, status, created_at, last_synced_at)
     VALUES (?, 'InfoAction', 'Expired Action', 'expired', ?, ?)`,
  ).bind(GA_EXPIRED, NOW, NOW).run();
}

function makeCtx(opts: { user: { id: string; roles: string[] } | null; body: unknown }) {
  const request = new Request('https://dreptalk.com/api/vote/liveness', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.body),
  });
  const locals = { user: opts.user } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof POST>[0];
}

const DREP_USER = { id: 'user-liveness-1', roles: ['drep'] };

describe('POST /api/vote/liveness', () => {
  it('returns 401 when not logged in as a DRep', async () => {
    const res = await POST(makeCtx({ user: null, body: { gaIds: [GA_ACTIVE] } }));
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid input', async () => {
    const res = await POST(makeCtx({ user: DREP_USER, body: { gaIds: ['nope'] } }));
    expect(res.status).toBe(400);
    const empty = await POST(makeCtx({ user: DREP_USER, body: { gaIds: [] } }));
    expect(empty.status).toBe(400);
  });

  it('returns only the ids that are still active', async () => {
    await seedActions();
    const res = await POST(makeCtx({ user: DREP_USER, body: { gaIds: [GA_ACTIVE, GA_EXPIRED, GA_UNKNOWN] } }));
    expect(res.status).toBe(200);
    const body = await res.json() as { active: string[] };
    expect(body.active).toEqual([GA_ACTIVE]);
  });
});
