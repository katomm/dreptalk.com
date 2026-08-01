// Node-mode tests for GET /vote-rationale/<hash>.json
// The stored body must be returned byte-for-byte: the on-chain anchor hash is
// blake2b-256 of exactly these bytes, so any re-serialization would break
// verification for our own hosted rationales.
import { describe, it, expect, vi } from 'vitest';

const KNOWN_HASH = 'a'.repeat(64);
// Minified, fixed key order: exactly what buildVoteRationale hashes and stores.
const STORED_BODY =
  '{"@context":{"CIP100":"https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#","hashAlgorithm":"CIP100:hashAlgorithm","body":{"@id":"CIP100:body","@context":{"comment":"CIP100:comment"}}},"hashAlgorithm":"blake2b-256","body":{"comment":"Because it strengthens the treasury."}}';

const { fakeDb } = vi.hoisted(() => {
  const db = {
    prepare: (_sql: string) => ({
      bind: (hash: unknown) => ({
        first: async <T>(): Promise<T | null> => (hash === KNOWN_HASH ? ({ body: STORED_BODY } as T) : null),
      }),
    }),
  };
  return { fakeDb: db };
});

vi.mock('cloudflare:workers', () => ({ env: { DB: fakeDb } }));

import { GET } from './[hash].json.js';

function makeCtx(hash: string) {
  const url = new URL(`https://dreptalk.com/vote-rationale/${hash}.json`);
  return {
    params: { hash },
    request: new Request(url),
    locals: {} as App.Locals,
    url,
  } as unknown as Parameters<typeof GET>[0];
}

describe('GET /vote-rationale/[hash].json', () => {
  it('returns 200 with the verbatim stored body', async () => {
    const res = await GET(makeCtx(KNOWN_HASH));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(STORED_BODY);
  });

  it('sets an immutable cache-control', async () => {
    const res = await GET(makeCtx(KNOWN_HASH));
    expect(res.headers.get('cache-control') ?? '').toContain('immutable');
  });

  it('returns 404 for an unknown hash', async () => {
    expect((await GET(makeCtx('b'.repeat(64)))).status).toBe(404);
  });

  it('returns 404 for a malformed hash without touching the db', async () => {
    expect((await GET(makeCtx('not-a-hash'))).status).toBe(404);
  });
});
