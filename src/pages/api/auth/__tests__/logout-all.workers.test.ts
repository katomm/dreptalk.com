/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/auth/logout-all.
// Calls the exported POST handler directly with a synthetic APIContext, the
// same convention as pair/__tests__/poll.workers.test.ts, so the
// test runs inside the real Workers runtime (KV) without an HTTP server or
// the Astro middleware chain.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createSession, getSession } from '@/lib/auth/session';
import { POST } from '../logout-all';

const USER_ID = 'user-logout-all-1';

function ctx(opts: { user: { id: string; roles: string[] } | null; sameOrigin?: boolean }) {
  const request = new Request('https://dreptalk.com/api/auth/logout-all', {
    method: 'POST',
    headers: { 'sec-fetch-site': opts.sameOrigin === false ? 'cross-site' : 'same-origin' },
  });
  const locals = { user: opts.user } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof POST>[0];
}

describe('POST /api/auth/logout-all', () => {
  it('revokes every session for the user, not just the caller', async () => {
    const a = await createSession(env.SESSIONS, { id: USER_ID, roles: ['drep'], drepId: null });
    const b = await createSession(env.SESSIONS, { id: USER_ID, roles: ['drep'], drepId: null });
    expect(await getSession(env.SESSIONS, a)).not.toBeNull();
    expect(await getSession(env.SESSIONS, b)).not.toBeNull();

    const res = await POST(ctx({ user: { id: USER_ID, roles: ['drep'] } }));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await getSession(env.SESSIONS, a)).toBeNull();
    expect(await getSession(env.SESSIONS, b)).toBeNull();
  });

  it('leaves other users sessions intact', async () => {
    const mine = await createSession(env.SESSIONS, { id: USER_ID, roles: [] });
    const other = await createSession(env.SESSIONS, { id: 'user-logout-all-other', roles: [] });

    await POST(ctx({ user: { id: USER_ID, roles: [] } }));

    expect(await getSession(env.SESSIONS, mine)).toBeNull();
    expect(await getSession(env.SESSIONS, other)).not.toBeNull();
  });

  it('redirects home without touching sessions when not signed in', async () => {
    const res = await POST(ctx({ user: null }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    // No cookie churn for a caller who was never signed in.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a cross-origin request', async () => {
    const token = await createSession(env.SESSIONS, { id: USER_ID, roles: [] });
    const res = await POST(
      ctx({ user: { id: USER_ID, roles: [] }, sameOrigin: false }),
    );
    expect(res.status).toBe(403);
    // Rejected before revocation runs: the session must still be live.
    expect(await getSession(env.SESSIONS, token)).not.toBeNull();
  });
});
