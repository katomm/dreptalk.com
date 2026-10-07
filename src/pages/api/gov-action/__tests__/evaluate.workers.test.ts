/// <reference types="@cloudflare/workers-types" />
// Wiring tests for POST /api/gov-action/evaluate. The handler's own tests live
// in evaluateHandler.workers.test.ts, this only checks that the route
// delegates with the runtime network: 404 on mainnet, 401 signed out, and a
// typed 400 on preprod that never reaches Koios.
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockNetwork: { network: 'mainnet' | 'preprod'; networkId: number; koiosBaseUrl: string } = {
  network: 'mainnet',
  networkId: 1,
  koiosBaseUrl: 'https://api.koios.rest/api/v1',
};

vi.mock('@/lib/api/response', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/response')>();
  return { ...actual, currentNetwork: () => mockNetwork };
});

const { POST } = await import('../evaluate.js');

function req(user: { id: string; roles: string[] } | null, body: string) {
  const request = new Request('https://dreptalk.com/api/gov-action/evaluate', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body,
  });
  return { request, locals: { user } as App.Locals } as Parameters<typeof POST>[0];
}

describe('POST /api/gov-action/evaluate', () => {
  beforeEach(() => {
    mockNetwork = { network: 'mainnet', networkId: 1, koiosBaseUrl: 'https://api.koios.rest/api/v1' };
  });

  it('404s on mainnet', async () => {
    const res = await POST(req({ id: 'eval-route-user', roles: [] }, '{}'));
    expect(res.status).toBe(404);
  });

  it('401s when signed out, even on preprod', async () => {
    mockNetwork = { network: 'preprod', networkId: 0, koiosBaseUrl: 'https://preprod.koios.rest/api/v1' };
    const res = await POST(req(null, '{}'));
    expect(res.status).toBe(401);
  });

  it('400s a malformed body on preprod', async () => {
    mockNetwork = { network: 'preprod', networkId: 0, koiosBaseUrl: 'https://preprod.koios.rest/api/v1' };
    const res = await POST(req({ id: 'eval-route-user', roles: [] }, '{}'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
  });
});
