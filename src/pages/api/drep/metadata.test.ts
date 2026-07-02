// Node-mode tests for POST /api/drep/metadata.
// Uses a fake D1 and a fake KV so this can run without Workers bindings.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted runs before the vi.mock factory (which is hoisted to top of the
// file by vitest), so these refs are safe to use inside the factory.
// ---------------------------------------------------------------------------

const { fakeDb, fakeRateLimiter } = vi.hoisted(() => {
  // Fake D1: records the last .bind() arguments so tests can inspect what
  // was persisted without a real database.
  interface FakeD1 {
    lastBound: unknown[] | null;
    prepare: (sql: string) => {
      bind: (...args: unknown[]) => { run: () => Promise<{ success: boolean }> };
    };
  }

  const db: FakeD1 = {
    lastBound: null,
    prepare: (_sql: string) => ({
      bind: (...args: unknown[]) => {
        db.lastBound = args;
        return { run: async () => ({ success: true }) };
      },
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
import { POST } from './metadata.js';

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

// Reset captured D1 args before each test.
beforeEach(() => {
  fakeDb.lastBound = null;
});

// ---------------------------------------------------------------------------
// Tests
//
// Hosting is unauthenticated (authenticity is bound on-chain by syncDreps) and
// content-addressed. The full store + build logic is covered, against real D1,
// in src/lib/governance/drepMetadataHandler.workers.test.ts. The route tests
// below cover the wiring: a well-formed body stores and returns 200, plus the
// gates that need no signature (malformed input, rate limiting).
// ---------------------------------------------------------------------------

describe('POST /api/drep/metadata: stores a well-formed document', () => {
  it('returns 200 with a content-addressed url + hash and writes the row', async () => {
    const ctx = makeCtx({
      drepId: VALID_DREP_ID,
      name: 'Alice Cardano',
      bio: 'Testing governance.',
      links: [{ uri: 'https://alice.example.com' }],
    });

    const res = await POST(ctx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; hash: string };
    expect(json.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.url).toBe(`${ORIGIN}/drep/${json.hash}.json`);

    // The INSERT bound the content-addressed row: [drepId, body, hash, name, createdAt].
    expect(fakeDb.lastBound).not.toBeNull();
    expect(fakeDb.lastBound![0]).toBe(VALID_DREP_ID);
    expect(fakeDb.lastBound![2]).toBe(json.hash);
  });
});

describe('POST /api/drep/metadata: invalid drepId', () => {
  it('returns 400 and does not store anything when drepId is "nope"', async () => {
    const ctx = makeCtx({
      drepId: 'nope',
      name: 'Alice',
      bio: 'bio',
      links: [],
    });

    const res = await POST(ctx);

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBeDefined();

    // Nothing must have been written to D1.
    expect(fakeDb.lastBound).toBeNull();
  });

  it('returns 400 when drepId is missing entirely', async () => {
    const ctx = makeCtx({ name: 'Alice', bio: 'bio', links: [] });
    const res = await POST(ctx);
    expect(res.status).toBe(400);
  });
});

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
