// Node-mode tests for GET /drep/[hash].json
// Uses a fake D1 whose .prepare().bind(hash).first() returns a row or null.
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted: fake D1 that serves one row keyed by hash or null.
// ---------------------------------------------------------------------------

const KNOWN_HASH = 'a'.repeat(64);
const KNOWN_ID = 'drep1yyqw67szjkwns4vfqvnk0v8r20zy5qmv3hge2qlxm0s3apgsp3qsk6j5t4';

// The stored body is the verbatim JSON string that was persisted.
// It must be returned byte-for-byte: do not parse/re-serialize.
const STORED_BODY = '{"@context":{"CIP119":"https://github.com/cardano-foundation/CIPs/blob/master/CIP-0119/README.md#"},"body":{"givenName":"Alice Cardano","objectives":"Testing governance.","references":[]}}';

import { vi } from 'vitest';

const { fakeDb } = vi.hoisted(() => {
  const db = {
    prepare: (_sql: string) => ({
      bind: (hash: unknown) => ({
        first: async <T>(): Promise<T | null> => {
          if (hash === KNOWN_HASH) {
            return {
              drep_id: KNOWN_ID,
              body: STORED_BODY,
              hash: KNOWN_HASH,
              name: 'Alice Cardano',
              created_at: 1700000000,
            } as T;
          }
          return null;
        },
      }),
    }),
  };
  return { fakeDb: db };
});

// Mock cloudflare:workers so the module resolves in Node test environment.
vi.mock('cloudflare:workers', () => ({
  env: {
    DB: fakeDb,
  },
}));

// Import after mock is registered.
import { GET } from '../[hash].json.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(hash: string) {
  const url = new URL(`https://dreptalk.com/drep/${hash}.json`);
  return {
    params: { hash },
    request: new Request(url),
    locals: {} as App.Locals,
    props: {},
    url,
    redirect: () => new Response(null, { status: 302 }),
    rewrite: () => new Response(null, { status: 200 }),
    clientAddress: '1.2.3.4',
    site: undefined,
    generator: 'Astro v6',
    cookies: {
      get: () => undefined,
      has: () => false,
      set: () => {},
      delete: () => {},
      headers: () => new Headers(),
      merge: () => {},
    },
  } as unknown as Parameters<typeof GET>[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /drep/[hash].json: known hash', () => {
  it('returns 200 with the verbatim stored body', async () => {
    const res = await GET(makeCtx(KNOWN_HASH));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(STORED_BODY);
  });

  it('sets content-type: application/json', async () => {
    const res = await GET(makeCtx(KNOWN_HASH));
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('sets immutable cache-control', async () => {
    const res = await GET(makeCtx(KNOWN_HASH));
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('immutable');
    expect(cc).toContain('max-age=31536000');
  });
});

describe('GET /drep/[hash].json: not found / invalid', () => {
  it('returns 404 for an unknown hash', async () => {
    const res = await GET(makeCtx('b'.repeat(64)));
    expect(res.status).toBe(404);
  });

  it('returns 404 for a malformed hash (not 64 hex) without touching the db', async () => {
    const res = await GET(makeCtx('not-a-hash'));
    expect(res.status).toBe(404);
  });
});
