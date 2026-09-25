// Node-mode tests for POST /api/drep/metadata.
// Uses a fake D1 and a fake rate limiter so this can run without Workers bindings.
import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted runs before the vi.mock factory (which is hoisted to top of the
// file by vitest), so these refs are safe to use inside the factory.
// ---------------------------------------------------------------------------

const { fakeDb, fakeRateLimiter } = vi.hoisted(() => {
  // Fake D1: accepts the INSERT of a well-formed body so the request reaches
  // the rate limiter on every call.
  const db = {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({ run: async () => ({ success: true }) }),
    }),
  };

  // Fake RATE_LIMITER Durable Object namespace: a Map-backed fixed-window counter
  // mirroring the real RateLimiter so the route's throttle works without workerd.
  const rlStore = new Map<string, { start: number; count: number }>();
  const rateLimiter = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      limit: async (opts: { max: number; windowSec: number; now: number }) => {
        const prev = rlStore.get(id);
        if (!prev || opts.now - prev.start >= opts.windowSec * 1000) {
          rlStore.set(id, { start: opts.now, count: 1 });
          return opts.max >= 1;
        }
        if (prev.count >= opts.max) return false;
        prev.count += 1;
        return true;
      },
    }),
  };

  return { fakeDb: db, fakeRateLimiter: rateLimiter };
});

// Mock cloudflare:workers so the module resolves in the Node test environment.
vi.mock('cloudflare:workers', () => ({
  env: {
    DB: fakeDb,
    RATE_LIMITER: fakeRateLimiter,
  },
}));

// Import after the mock is registered.
import { POST } from '../metadata.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_DREP_ID = 'drep1yyqw67szjkwns4vfqvnk0v8r20zy5qmv3hge2qlxm0s3apgsp3qsk6j5t4';
const ORIGIN = 'https://dreptalk.com';

function makeRequest(body: unknown, ip = '1.2.3.4'): Request {
  return new Request(`${ORIGIN}/api/drep/metadata`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify(body),
  });
}

function makeCtx(body: unknown, ip = '1.2.3.4') {
  const request = makeRequest(body, ip);
  return {
    request,
    locals: {} as App.Locals,
    params: {},
    props: {},
    url: new URL(request.url),
    redirect: () => new Response(null, { status: 302 }),
    rewrite: () => new Response(null, { status: 200 }),
    clientAddress: ip,
    site: undefined,
    generator: 'Astro v5',
    cookies: {
      get: () => undefined,
      has: () => false,
      set: () => {},
      delete: () => {},
      headers: () => new Headers(),
      merge: () => {},
    },
  } as unknown as Parameters<typeof POST>[0];
}

// ---------------------------------------------------------------------------
// Tests
//
// Hosting is unauthenticated (authenticity is bound on-chain by syncDreps) and
// content-addressed. The store + build logic and the drepId validation are
// covered, against real D1, in src/lib/governance/drepMetadataHandler.workers.test.ts.
// The route test below covers only the gate the route adds: rate limiting.
// ---------------------------------------------------------------------------

describe('POST /api/drep/metadata: rate limiting', () => {
  it('returns 429 after the fixed-window limit is hit from the same IP', async () => {
    // Use a unique IP so the counter is fresh.
    const ip = '9.9.9.1';

    // Hit the endpoint 10 times (the limit for drep metadata is 10/60s).
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const ctx = makeCtx(
        { drepId: VALID_DREP_ID, name: 'Eve', bio: 'bio', links: [] },
        ip,
      );
      const res = await POST(ctx);
      lastStatus = res.status;
      // Drain the body to avoid leaking resources.
      await res.text();
    }

    expect(lastStatus).toBe(429);
  });
});
