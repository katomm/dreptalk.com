// Node-mode tests for GET /drep/[drepId]/metadata.json
// Uses a fake D1 whose .prepare().bind().first() returns a stored row or null.
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted: fake D1 that can serve one row or null based on a known id.
// ---------------------------------------------------------------------------

const KNOWN_ID = 'drep1yyqw67szjkwns4vfqvnk0v8r20zy5qmv3hge2qlxm0s3apgsp3qsk6j5t4';

// The stored body is the verbatim JSON string that was persisted.
// It must be returned byte-for-byte: do not parse/re-serialize.
const STORED_BODY = '{"@context":{"CIP119":"https://github.com/cardano-foundation/CIPs/blob/master/CIP-0119/README.md#","body":{"@id":"CIP119:body","@context":{"bio":"CIP119:bio","title":"CIP119:title","references":{"@id":"CIP119:references","@container":"@set"},"doesNotParticipateInGovernance":"CIP119:doesNotParticipateInGovernance"}}},"body":{"bio":"Testing governance.","title":"Alice Cardano","references":[{"@type":"Other","label":"Personal site","uri":"https://alice.example.com"}]}}';

// vi.hoisted so the mock factory can reference fakeDb before import.
import { vi } from 'vitest';

const { fakeDb } = vi.hoisted(() => {
  // Parameterized fake: .prepare().bind(id).first() returns a row if id matches.
  const db = {
    prepare: (_sql: string) => ({
      bind: (id: unknown) => ({
        first: async <T>(): Promise<T | null> => {
          if (id === KNOWN_ID) {
            return {
              drep_id: KNOWN_ID,
              body: STORED_BODY,
              hash: 'abc123',
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
import { GET } from './[drepId]/metadata.json.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(drepId: string) {
  const url = new URL(`https://dreptalk.com/drep/${drepId}/metadata.json`);
  return {
    params: { drepId },
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

describe('GET /drep/[drepId]/metadata.json: known id', () => {
  it('returns 200 with the verbatim stored body', async () => {
    const ctx = makeCtx(KNOWN_ID);
    const res = await GET(ctx);

    expect(res.status).toBe(200);
    const text = await res.text();
    // Body must be exactly the stored string, not re-serialized.
    expect(text).toBe(STORED_BODY);
  });

  it('sets content-type: application/json', async () => {
    const ctx = makeCtx(KNOWN_ID);
    const res = await GET(ctx);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('sets immutable cache-control', async () => {
    const ctx = makeCtx(KNOWN_ID);
    const res = await GET(ctx);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('immutable');
    expect(cc).toContain('max-age=31536000');
  });
});

describe('GET /drep/[drepId]/metadata.json: unknown id', () => {
  it('returns 404 for an unknown drep id', async () => {
    const ctx = makeCtx('drep1unknown99999999999999');
    const res = await GET(ctx);
    expect(res.status).toBe(404);
  });
});
