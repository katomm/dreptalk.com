/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for GET /api/gov-action/context. The route only
// wires up the real Koios client and delegates to handleActionContext (its
// own tests live in actionContextHandler.workers.test.ts), so this file only
// checks that the wiring itself works: network gating, session gating, and a
// 200 with a mocked Koios client on preprod.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted, so the mutable network ref lets each test pick mainnet
// or preprod without re-mocking the module.
let mockNetwork: { network: 'mainnet' | 'preprod'; networkId: number; koiosBaseUrl: string } = {
  network: 'mainnet',
  networkId: 1,
  koiosBaseUrl: 'https://api.koios.rest/api/v1',
};

vi.mock('@/lib/api/response', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/response')>();
  return {
    ...actual,
    currentNetwork: () => mockNetwork,
  };
});

const koiosMock = {
  tip: vi.fn(async () => ({ epoch_no: 700 })),
  epochParams: vi.fn(async () => null),
  lastRatifiedProposal: vi.fn(async () => []),
  openProposals: vi.fn(async () => []),
  committeeContext: vi.fn(async () => ({ members: [], quorum: null })),
};

vi.mock('@/lib/koios/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/koios/client')>();
  return { ...actual, createKoiosClient: () => koiosMock };
});

const { GET } = await import('../context.js');

function req(user: { id: string; roles: string[] } | null) {
  const request = new Request('https://dreptalk.com/api/gov-action/context?type=InfoAction', {
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  const locals = { user } as App.Locals;
  return { request, locals } as Parameters<typeof GET>[0];
}

const USER = { id: 'ctx-route-user', roles: [] };

describe('GET /api/gov-action/context', () => {
  beforeEach(() => {
    mockNetwork = { network: 'mainnet', networkId: 1, koiosBaseUrl: 'https://api.koios.rest/api/v1' };
  });

  it('404s on mainnet', async () => {
    const res = await GET(req(USER));
    expect(res.status).toBe(404);
  });

  it('401s when signed out, even on preprod', async () => {
    mockNetwork = { network: 'preprod', networkId: 0, koiosBaseUrl: 'https://preprod.koios.rest/api/v1' };
    const res = await GET(req(null));
    expect(res.status).toBe(401);
  });

  it('200s with the expected shape on preprod', async () => {
    mockNetwork = { network: 'preprod', networkId: 0, koiosBaseUrl: 'https://preprod.koios.rest/api/v1' };
    const res = await GET(req(USER));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ epoch: 700 });
  });
});
