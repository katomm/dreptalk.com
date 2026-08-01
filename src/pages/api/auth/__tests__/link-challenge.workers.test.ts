/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/auth/link-challenge.
// Calls the exported POST handler directly with a synthetic APIContext, the
// same convention as pair/poll.workers.test.ts, so the test exercises the real
// D1-backed nonce issuance and Durable Object rate limiter without an HTTP
// server or the Astro middleware chain.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { POST } from '../link-challenge';

const USER_ID = 'user-link-challenge-1';

function ctx(user: { id: string; roles: string[] } | null, headers: Record<string, string> = {}) {
  const request = new Request('https://dreptalk.com/api/auth/link-challenge', {
    method: 'POST',
    headers: { origin: 'https://dreptalk.com', ...headers },
  });
  const locals = { user } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof POST>[0];
}

describe('POST /api/auth/link-challenge', () => {
  it('returns 401 when no session is present', async () => {
    const res = await POST(ctx(null));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('returns 403 for a signed-in member (not a writer role)', async () => {
    const res = await POST(ctx({ id: USER_ID, roles: ['member'] }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('forbidden');
  });

  it('returns 403 for a cross-origin request even from a writer', async () => {
    const res = await POST(ctx({ id: USER_ID, roles: ['drep'] }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
  });

  it('issues a nonce payload scoped to link_stake:<user.id> for a writer role', async () => {
    const res = await POST(ctx({ id: USER_ID, roles: ['drep'] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payload: string };
    expect(body.payload).toMatch(new RegExp(`^dreptalk:link_stake:${USER_ID}:[^:]+:\\d+$`));

    // The issued nonce is actually persisted, so the later link-stake verify
    // step can find and consume it.
    const parts = body.payload.split(':');
    const nonce = parts[parts.length - 2];
    const row = await env.DB.prepare('SELECT nonce FROM auth_nonces WHERE nonce = ?1').bind(nonce).first();
    expect(row).not.toBeNull();
  });

  it('rate-limits repeated calls per account', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await POST(ctx({ id: USER_ID, roles: ['drep'] }));
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});
