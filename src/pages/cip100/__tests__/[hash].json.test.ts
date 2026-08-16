// src/pages/cip100/__tests__/[hash].json.test.ts
// Node-mode tests for GET /cip100/<hash>.json. The cache contract is part of
// the deletion design, so it is asserted here and not treated as cosmetic.
import { describe, it, expect, vi } from 'vitest';

const KNOWN = 'a'.repeat(64);
const DELETED = 'b'.repeat(64);
const HIDDEN = 'd'.repeat(64);
const BODY = '{"hashAlgorithm":"blake2b-256"}';

const { fakeDb } = vi.hoisted(() => {
  const rows: Record<string, { body: string | null; state: string }> = {
    ['a'.repeat(64)]: { body: '{"hashAlgorithm":"blake2b-256"}', state: 'available' },
    ['b'.repeat(64)]: { body: null, state: 'gone' },
    ['d'.repeat(64)]: { body: '{"hashAlgorithm":"blake2b-256"}', state: 'hidden' },
  };
  return {
    fakeDb: {
      prepare: (_sql: string) => ({
        bind: (hash: unknown) => ({
          first: async <T>(): Promise<T | null> => (rows[hash as string] ?? null) as T | null,
        }),
      }),
    },
  };
});

vi.mock('cloudflare:workers', () => ({ env: { DB: fakeDb } }));

import { GET, OPTIONS } from '../[hash].json.js';

const call = (hash: string, headers: Record<string, string> = {}) =>
  GET({
    params: { hash },
    locals: {},
    request: new Request(`https://dreptalk.com/cip100/${hash}.json`, { headers }),
  } as never);

describe('GET /cip100/<hash>.json', () => {
  it('serves stored bytes verbatim with an ETag', async () => {
    const res = await call(KNOWN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
    expect(res.headers.get('etag')).toBe(`"${KNOWN}"`);
    expect(res.headers.get('content-type')).toBe('application/ld+json; charset=utf-8');
  });

  it('never claims immutable, so a deletion can reach caches', async () => {
    const res = await call(KNOWN);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, must-revalidate');
    expect(res.headers.get('cache-control')).not.toContain('immutable');
  });

  it('answers 304 when the ETag matches', async () => {
    const res = await call(KNOWN, { 'if-none-match': `"${KNOWN}"` });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('honours weak tags, tag lists and the wildcard', async () => {
    // Caches and proxies send all three forms. Comparing the raw header against
    // one quoted tag would turn a free 304 into a full re-download.
    for (const header of [`W/"${KNOWN}"`, `"x", W/"${KNOWN}"`, '*']) {
      expect((await call(KNOWN, { 'if-none-match': header })).status).toBe(304);
    }
    expect((await call(KNOWN, { 'if-none-match': '"someone-elses-tag"' })).status).toBe(200);
  });

  it('answers 410 for a deleted document even when the ETag matches', async () => {
    const res = await call(DELETED, { 'if-none-match': `"${DELETED}"` });
    expect(res.status).toBe(410);
  });

  it('404s a hidden post rather than claiming it is gone', async () => {
    // 410 is terminal and belongs to deletion. Hiding is reversible, so the
    // answer must not tell a consumer to stop asking.
    const res = await call(HIDDEN, { 'if-none-match': `"${HIDDEN}"` });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('hashAlgorithm');
  });

  it('404s an unknown hash', async () => {
    expect((await call('c'.repeat(64))).status).toBe(404);
  });

  it('404s a malformed hash', async () => {
    expect((await call('nope')).status).toBe(404);
  });

  // These documents exist to be read by somebody else's tool, and a browser
  // client that cannot read the status cannot tell a 404 from a dead network.
  it('allows cross-origin reads on every answer, including the error ones', async () => {
    for (const res of [await call(KNOWN), await call(DELETED), await call(HIDDEN), await call('nope')]) {
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('exposes the ETag to script, or revalidation is impossible cross-origin', async () => {
    const res = await call(KNOWN);
    expect(res.headers.get('access-control-expose-headers')).toBe('ETag');
    expect((await call(KNOWN, { 'if-none-match': `"${KNOWN}"` })).headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers the preflight that If-None-Match triggers', async () => {
    // If-None-Match is not CORS-safelisted, so a conditional cross-origin
    // request is preceded by an OPTIONS. Without this the whole
    // revalidate-instead-of-immutable design is unusable from a browser.
    const res = await OPTIONS({} as never);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('If-None-Match');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });
});
