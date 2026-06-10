import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST, _setFetchImpl } from './[...path]';

// Minimal stand-ins for the Astro APIRoute context objects.
function makeContext(
  method: string,
  url: string,
  body?: string,
  contentType?: string,
): Parameters<typeof GET>[0] {
  const headers = new Headers();
  if (contentType) headers.set('content-type', contentType);
  const req = new Request(url, { method, headers, body: body ?? null });
  return {
    request: req,
    params: { path: new URL(url).pathname.replace('/api/koios/', '') },
  } as unknown as Parameters<typeof GET>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  // Reset the injectable fetch after each test.
  _setFetchImpl(globalThis.fetch ?? (() => Promise.reject(new Error('no fetch'))));
});

describe('koios proxy: GET forwarding', () => {
  it('forwards GET /api/koios/epoch_params (allowed read endpoint) to the Koios host and returns upstream body+status', async () => {
    const upstream = [{ epoch_no: 500, min_fee_a: 44 }];
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(upstream, 200));
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const ctx = makeContext(
      'GET',
      'https://dreptalk.com/api/koios/epoch_params?limit=1&order=epoch_no.desc',
    );

    const res = await GET(ctx);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(upstream);

    // The forwarded URL must contain the Koios host and the correct path.
    expect(mockFetch).toHaveBeenCalledOnce();
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toMatch(/koios\.rest/);
    expect(calledUrl).toContain('/epoch_params');
    expect(calledUrl).toContain('order=epoch_no.desc');
  });

  it('rejects GET to a non-allowlisted path with 403 and never calls upstream', async () => {
    const mockFetch = vi.fn();
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    // tip is a real Koios endpoint but is not routed through this proxy, so
    // deny-by-default must reject it without contacting the upstream.
    const ctx = makeContext('GET', 'https://dreptalk.com/api/koios/tip');
    const res = await GET(ctx);

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('injects the Bearer token when KOIOS_API_KEY is set', async () => {
    process.env.KOIOS_API_KEY = 'test-token';
    try {
      const upstream = [{ drep_id: 'drep1xyz' }];
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(upstream));
      _setFetchImpl(mockFetch as unknown as typeof fetch);

      const ctx = makeContext('GET', 'https://dreptalk.com/api/koios/epoch_params');
      await GET(ctx);

      const callInit = mockFetch.mock.calls[0][1] as RequestInit & {
        headers: Headers | Record<string, string>;
      };
      const authHeader =
        callInit.headers instanceof Headers
          ? callInit.headers.get('authorization')
          : (callInit.headers as Record<string, string>).authorization ??
            (callInit.headers as Record<string, string>).Authorization;
      expect(authHeader).toBe('Bearer test-token');
    } finally {
      delete process.env.KOIOS_API_KEY;
    }
  });

  it('never forwards the client cookie or authorization headers to Koios', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse([{ ok: true }]));
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const req = new Request('https://dreptalk.com/api/koios/epoch_params', {
      method: 'GET',
      headers: { cookie: 'session=secret', authorization: 'Bearer client-token' },
    });
    const ctx = {
      request: req,
      params: { path: 'epoch_params' },
    } as unknown as Parameters<typeof GET>[0];

    await GET(ctx);

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const fwd = new Headers(init.headers);
    // No server KOIOS_API_KEY here, so neither the client cookie nor the
    // client bearer must reach the upstream.
    expect(fwd.get('cookie')).toBeNull();
    expect(fwd.get('authorization')).toBeNull();
  });
});

describe('koios proxy: POST forwarding', () => {
  it('forwards POST /api/koios/drep_info (allowed bulk-read endpoint) and returns upstream response', async () => {
    const upstream = [{ drep_id: 'drep1abc' }];
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(upstream));
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const ctx = makeContext(
      'POST',
      'https://dreptalk.com/api/koios/drep_info',
      JSON.stringify({ _drep_ids: ['drep1abc'] }),
      'application/json',
    );

    const res = await POST(ctx);

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/drep_info');
  });

  it('rejects POST to /api/koios/submittx with 403', async () => {
    const mockFetch = vi.fn();
    _setFetchImpl(mockFetch as unknown as typeof fetch);

    const ctx = makeContext(
      'POST',
      'https://dreptalk.com/api/koios/submittx',
      'cbor',
      'application/cbor',
    );

    const res = await POST(ctx);

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('koios proxy: method rejection', () => {
  it('does not export PUT (only GET and POST are exposed)', async () => {
    // Only GET and POST are exported: other HTTP methods are not handled,
    // so Astro returns 405 automatically.
    const mod = await import('./[...path]');
    expect((mod as Record<string, unknown>).PUT).toBeUndefined();
    expect((mod as Record<string, unknown>).PATCH).toBeUndefined();
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
