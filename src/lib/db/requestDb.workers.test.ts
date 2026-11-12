// Drives the real middleware and checks which D1 handle a render sees: a
// session for anonymous reads, the plain binding for everything else.
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';

vi.mock('astro:middleware', () => ({
  defineMiddleware: (fn: unknown) => fn,
  sequence: (...fns: unknown[]) => fns,
}));

import { onRequest } from '../../middleware.js';
import { createSession } from '../auth/session.js';
import { runtimeEnv } from '../api/response.js';
import { mayReadFromReplica, requestDb, runWithRequestDb } from './requestDb.js';

type Ctx = Parameters<typeof onRequest>[0];

const isSession = (db: unknown): boolean =>
  db !== env.DB && typeof (db as { getBookmark?: unknown })?.getBookmark === 'function';

/** Runs one request through the middleware and returns the handles the render saw. */
async function handlesFor(url: string, init?: RequestInit) {
  const seen: { requestDb?: D1Database; runtimeEnvDb?: D1Database } = {};
  const context = {
    request: new Request(url, init),
    locals: {},
    redirect: (u: string, s: number) => new Response(null, { status: s, headers: { Location: u } }),
  } as unknown as Ctx;
  await onRequest(context, async () => {
    seen.requestDb = requestDb();
    seen.runtimeEnvDb = runtimeEnv().DB as D1Database;
    // The handle must actually query, whichever kind it is.
    await seen.requestDb!.prepare('SELECT 1').first();
    return new Response('ok');
  });
  return seen;
}

describe('mayReadFromReplica', () => {
  it('allows anonymous GET and HEAD pages', () => {
    expect(mayReadFromReplica(new Request('https://dreptalk.com/t/x/'))).toBe(true);
    expect(mayReadFromReplica(new Request('https://dreptalk.com/t/x/', { method: 'HEAD' }))).toBe(true);
  });

  it('keeps other cookies anonymous, like the page cache', () => {
    const req = new Request('https://dreptalk.com/t/x/', { headers: { Cookie: 'theme=dark' } });
    expect(mayReadFromReplica(req)).toBe(true);
  });

  it('refuses a session cookie, every other method and the primary-only paths', () => {
    const signedIn = new Request('https://dreptalk.com/t/x/', { headers: { Cookie: 'dreptalk_session=abc' } });
    expect(mayReadFromReplica(signedIn)).toBe(false);
    expect(mayReadFromReplica(new Request('https://dreptalk.com/api/x', { method: 'POST' }))).toBe(false);
    expect(mayReadFromReplica(new Request('https://dreptalk.com/api/drep/multisig/abc'))).toBe(false);
    expect(mayReadFromReplica(new Request('https://dreptalk.com/api/drep/multisig'))).toBe(false);
    expect(mayReadFromReplica(new Request('https://dreptalk.com/api/gov-action/status?tx=1'))).toBe(false);
  });
});

describe('request D1 handle through the middleware', () => {
  it('gives an anonymous page a session, through requestDb and runtimeEnv alike', async () => {
    const seen = await handlesFor('https://dreptalk.com/t/some-thread/');
    expect(isSession(seen.requestDb)).toBe(true);
    expect(seen.runtimeEnvDb).toBe(seen.requestDb);
  });

  it('keeps a signed-in request on the plain binding', async () => {
    const token = await createSession(env.SESSIONS, { id: 'rdb-user', roles: ['drep'], drepId: 'd1' });
    const seen = await handlesFor('https://dreptalk.com/t/some-thread/', {
      headers: { Cookie: `dreptalk_session=${token}` },
    });
    expect(seen.requestDb).toBe(env.DB);
  });

  it('keeps a POST on the plain binding', async () => {
    const seen = await handlesFor('https://dreptalk.com/api/auth/challenge', {
      method: 'POST',
      headers: { Origin: 'https://dreptalk.com' },
    });
    expect(seen.requestDb).toBe(env.DB);
  });

  it('gives overlapping requests separate handles, shared within each request', async () => {
    const reqs = ['https://dreptalk.com/a/', 'https://dreptalk.com/b/'].map((url) => new Request(url));
    const pairs = await Promise.all(
      reqs.map((request) =>
        runWithRequestDb(request, async () => {
          const first = requestDb();
          await new Promise((r) => setTimeout(r, 5));
          return [first, requestDb()] as const;
        }),
      ),
    );
    expect(pairs[0][0]).toBe(pairs[0][1]);
    expect(pairs[1][0]).toBe(pairs[1][1]);
    expect(pairs[0][0]).not.toBe(pairs[1][0]);
  });

  it('falls back to the plain binding outside a request', () => {
    expect(requestDb()).toBe(env.DB);
    expect(runtimeEnv().DB).toBe(env.DB);
  });

  it('keeps every other binding reachable through runtimeEnv', () => {
    expect(runtimeEnv().SESSIONS).toBe(env.SESSIONS);
  });
});
