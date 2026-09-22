/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for GET /api/gov-action/status. The route only wires
// up the runtime env and delegates to handleActionStatus (its own tests live
// in actionStatusHandler.workers.test.ts), so this file only checks that the
// wiring itself works: network gating, session gating, and a 200 with the
// expected shape on preprod.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted, so the mutable network ref lets each test pick mainnet
// or preprod without re-mocking the module.
let mockNetwork: { network: 'mainnet' | 'preprod'; networkId: number } = {
  network: 'mainnet',
  networkId: 1,
};

vi.mock('@/lib/api/response', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/response')>();
  return {
    ...actual,
    currentNetwork: () => mockNetwork,
  };
});

const { GET } = await import('../status.js');

function req(user: { id: string; roles: string[] } | null, id = `${'a'.repeat(64)}#0`) {
  const request = new Request(`https://dreptalk.com/api/gov-action/status?id=${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  const locals = { user } as App.Locals;
  return { request, locals } as Parameters<typeof GET>[0];
}

const USER = { id: 'status-route-user', roles: [] };

describe('GET /api/gov-action/status', () => {
  beforeEach(() => {
    mockNetwork = { network: 'mainnet', networkId: 1 };
  });

  it('404s on mainnet', async () => {
    const res = await GET(req(USER));
    expect(res.status).toBe(404);
  });

  it('401s when signed out, even on preprod', async () => {
    mockNetwork = { network: 'preprod', networkId: 0 };
    const res = await GET(req(null));
    expect(res.status).toBe(401);
  });

  it('200s with the expected shape on preprod for an unknown id', async () => {
    mockNetwork = { network: 'preprod', networkId: 0 };
    const res = await GET(req(USER));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ synced: false, slug: null, draft: null });
  });

  it('400s on a malformed id, even on preprod', async () => {
    mockNetwork = { network: 'preprod', networkId: 0 };
    const res = await GET(req(USER, 'not-an-id'));
    expect(res.status).toBe(400);
  });
});
