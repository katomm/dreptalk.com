// Drives the real onRequest through its session step. astro:middleware is a
// virtual module, so it is stubbed to hand back the bare handler.
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';

vi.mock('astro:middleware', () => ({
  defineMiddleware: (fn: unknown) => fn,
  sequence: (...fns: unknown[]) => fns,
}));

import { onRequest } from './middleware.js';
import { createSession, sessionIdForToken } from './lib/auth/session.js';

type Ctx = Parameters<typeof onRequest>[0];

async function mintWith(extra: Record<string, unknown>): Promise<string> {
  const token = await createSession(env.SESSIONS, { id: 'mw-user', roles: ['drep'], drepId: 'd1' });
  const key = `sess:${await sessionIdForToken(token)}`;
  const rec = JSON.parse((await env.SESSIONS.get(key))!);
  await env.SESSIONS.put(key, JSON.stringify({ ...rec, ...extra }));
  return token;
}

async function run(token: string) {
  const locals: Record<string, unknown> = {};
  const context = {
    request: new Request('https://dreptalk.com/home/', { headers: { Cookie: `dreptalk_session=${token}` } }),
    locals,
    redirect: (u: string, s: number) => new Response(null, { status: s, headers: { Location: u } }),
  } as unknown as Ctx;
  const res = (await onRequest(context, async () => new Response('ok'))) as Response;
  return { locals, res };
}

describe('onRequest session handling', () => {
  it('drops a grant-pinned session: no user and a clearing Set-Cookie', async () => {
    const { locals, res } = await run(await mintWith({ grantId: 'g1' }));
    expect(locals.user).toBeNull();
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('dreptalk_session=');
    expect(cookie).toMatch(/Max-Age=0/i);
  });

  it('keeps a session with null grantId and actsFor: user set, no cookie change', async () => {
    const { locals, res } = await run(await mintWith({ grantId: null, actsFor: null }));
    expect(locals.user).toMatchObject({ id: 'mw-user', roles: ['drep'] });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
