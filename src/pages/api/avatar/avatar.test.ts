// Node-mode tests for GET /api/avatar/[drepId].
// Injects a fake D1 (returning a drep row) and a mock fetch.
// Runs via: npx vitest run --project node src/pages/api/avatar/avatar.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Fake D1 setup: supports .prepare().bind().first<T>() returning a drep row.
// ---------------------------------------------------------------------------

const { fakeDb } = vi.hoisted(() => {
  // Minimal Drep row shape: only the fields the avatar proxy reads.
  interface FakeRow {
    drep_id: string;
    image_url: string | null;
    // Other fields omitted; getDrepById maps the whole row but tests only
    // need these two to exercise the proxy's branches.
    hex: null;
    has_script: 0;
    status: string;
    active: 0;
    deposit: null;
    voting_power: null;
    expires_epoch_no: null;
    name: null;
    bio: null;
    links: null;
    anchor_url: null;
    anchor_hash: null;
    anchor_status: string;
    last_synced_at: number;
    created_at: number;
  }

  // Registry: maps drepId to the row to return (or null for "not found").
  const registry = new Map<string, FakeRow | null>();

  const db = {
    _registry: registry,
    prepare: (_sql: string) => ({
      bind: (id: string) => ({
        first: async <T>(): Promise<T | null> => {
          const row = registry.get(id);
          return (row ?? null) as unknown as T | null;
        },
      }),
    }),
  };

  return { fakeDb: db };
});

// Mock cloudflare:workers so runtimeEnv() resolves in Node tests.
vi.mock('cloudflare:workers', () => ({
  env: { DB: fakeDb },
}));

// Import the handler AFTER mocks are registered.
import { GET, _setFetchImpl } from './[drepId].js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_DREP_ID = 'drep1yyqw67szjkwns4vfqvnk0v8r20zy5qmv3hge2qlxm0s3apgsp3qsk6j5t4';
const HTTPS_IMAGE_URL = 'https://example.com/avatar.png';

/** Builds a minimal full DrepRow for the fake D1 registry. */
function makeRow(drepId: string, imageUrl: string | null) {
  return {
    drep_id: drepId,
    image_url: imageUrl,
    hex: null,
    has_script: 0 as const,
    status: 'registered',
    active: 0 as const,
    deposit: null,
    voting_power: null,
    expires_epoch_no: null,
    name: null,
    bio: null,
    links: null,
    anchor_url: null,
    anchor_hash: null,
    anchor_status: 'ok',
    last_synced_at: 0,
    created_at: 0,
  };
}

/** Builds an APIRoute-like context for GET /api/avatar/<drepId>. */
function makeCtx(drepId: string) {
  const request = new Request(`https://dreptalk.com/api/avatar/${drepId}`);
  return {
    request,
    params: { drepId },
    locals: {} as App.Locals,
    props: {},
    url: new URL(request.url),
    redirect: () => new Response(null, { status: 302 }),
    rewrite: () => new Response(null, { status: 200 }),
    clientAddress: '127.0.0.1',
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
  } as unknown as Parameters<typeof GET>[0];
}

/** Builds a fake upstream Response with the given content-type and body. */
function fakeImageResponse(
  contentType: string,
  body: Uint8Array | string,
  status = 200,
): Response {
  // Uint8Array must be wrapped in a buffer for the Response constructor.
  const bodyInit: BodyInit = typeof body === 'string' ? body : body.buffer as ArrayBuffer;
  return new Response(bodyInit, {
    status,
    headers: { 'content-type': contentType },
  });
}

// Reset injectable fetch and D1 registry before each test.
beforeEach(() => {
  fakeDb._registry.clear();
  _setFetchImpl(
    (() => Promise.reject(new Error('fetch called unexpectedly'))) as unknown as typeof fetch,
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/avatar/[drepId]: valid https image', () => {
  it('returns 200 with image bytes, correct content-type and immutable cache-control', async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

    fakeDb._registry.set(VALID_DREP_ID, makeRow(VALID_DREP_ID, HTTPS_IMAGE_URL));

    const mockFetch = vi.fn().mockResolvedValue(fakeImageResponse('image/png', imageBytes));
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const res = await GET(makeCtx(VALID_DREP_ID));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');

    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('public');
    expect(cc).toContain('immutable');
    expect(cc).toContain('max-age=86400');
    expect(cc).toContain('s-maxage=604800');

    // Body must contain the image bytes.
    const buf = await res.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(imageBytes);

    // Fetch was called exactly once with the https image URL.
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe(HTTPS_IMAGE_URL);
  });
});

describe('GET /api/avatar/[drepId]: drep with no image_url', () => {
  it('returns 404 without calling fetch', async () => {
    fakeDb._registry.set(VALID_DREP_ID, makeRow(VALID_DREP_ID, null));

    const mockFetch = vi.fn();
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const res = await GET(makeCtx(VALID_DREP_ID));

    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/avatar/[drepId]: unknown drep', () => {
  it('returns 404 when D1 returns no row', async () => {
    // Registry empty: D1 returns null.
    const mockFetch = vi.fn();
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const res = await GET(makeCtx('drep1unknown'));

    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/avatar/[drepId]: upstream non-image content-type', () => {
  it('returns 404 when upstream sends text/html', async () => {
    fakeDb._registry.set(VALID_DREP_ID, makeRow(VALID_DREP_ID, HTTPS_IMAGE_URL));

    const mockFetch = vi.fn().mockResolvedValue(
      fakeImageResponse('text/html', '<html>not an image</html>'),
    );
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const res = await GET(makeCtx(VALID_DREP_ID));

    expect(res.status).toBe(404);
  });
});

describe('GET /api/avatar/[drepId]: non-https image_url', () => {
  it('returns 404 for http:// URL without calling fetch', async () => {
    fakeDb._registry.set(VALID_DREP_ID, makeRow(VALID_DREP_ID, 'http://example.com/avatar.png'));

    const mockFetch = vi.fn();
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const res = await GET(makeCtx(VALID_DREP_ID));

    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 404 for data: URL without calling fetch', async () => {
    fakeDb._registry.set(VALID_DREP_ID, makeRow(VALID_DREP_ID, 'data:image/png;base64,abc'));

    const mockFetch = vi.fn();
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const res = await GET(makeCtx(VALID_DREP_ID));

    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 404 for javascript: URL without calling fetch', async () => {
    fakeDb._registry.set(VALID_DREP_ID, makeRow(VALID_DREP_ID, 'javascript:alert(1)'));

    const mockFetch = vi.fn();
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const res = await GET(makeCtx(VALID_DREP_ID));

    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/avatar/[drepId]: oversize body', () => {
  it('returns 404 when response body exceeds the cap', async () => {
    fakeDb._registry.set(VALID_DREP_ID, makeRow(VALID_DREP_ID, HTTPS_IMAGE_URL));

    // Build a 300 KB response body (above the 256 KB cap).
    const oversizeBody = new Uint8Array(300 * 1024).fill(0xff);
    const mockFetch = vi.fn().mockResolvedValue(fakeImageResponse('image/png', oversizeBody));
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const res = await GET(makeCtx(VALID_DREP_ID));

    expect(res.status).toBe(404);
  });

  it('returns 404 when content-length header declares an oversize body', async () => {
    fakeDb._registry.set(VALID_DREP_ID, makeRow(VALID_DREP_ID, HTTPS_IMAGE_URL));

    // content-length says 300 KB but body is empty; the proxy should reject early.
    const earlyReject = new Response(new Uint8Array(1), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(300 * 1024),
      },
    });
    const mockFetch = vi.fn().mockResolvedValue(earlyReject);
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const res = await GET(makeCtx(VALID_DREP_ID));

    expect(res.status).toBe(404);
  });
});
