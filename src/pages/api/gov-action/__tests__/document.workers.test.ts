/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/gov-action/document. The route only
// delegates to handleConstitutionDocument (its own tests live in
// constitutionDocumentHandler.workers.test.ts), so this file only checks that
// the wiring itself works: network gating, session gating, and a 200 with a
// mocked Pinata upload on preprod.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

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
    runtimeEnv: () => ({ ...env, PINATA_JWT: 'jwt' }),
  };
});

const CID = 'bafybeihgxdzljxb26q6nf3r3eifqeedsvt2eubqtskghpme66cgjyw4fra';

vi.mock('@/lib/governance/pinata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/governance/pinata')>();
  return {
    ...actual,
    pinDocument: async (_input: { bytes: Uint8Array }) => ({ cid: CID, fileId: 'file-route' }),
  };
});

const { POST } = await import('../document.js');

function req(user: { id: string; roles: string[] } | null, text = '# Constitution') {
  const request = new Request('https://dreptalk.com/api/gov-action/document', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ text }),
  });
  const locals = { user } as App.Locals;
  return { request, locals } as Parameters<typeof POST>[0];
}

const USER = { id: 'doc-route-user', roles: [] };

describe('POST /api/gov-action/document', () => {
  beforeEach(() => {
    mockNetwork = { network: 'mainnet', networkId: 1 };
  });

  it('404s on mainnet', async () => {
    const res = await POST(req(USER));
    expect(res.status).toBe(404);
  });

  it('401s when signed out, even on preprod', async () => {
    mockNetwork = { network: 'preprod', networkId: 0 };
    const res = await POST(req(null));
    expect(res.status).toBe(401);
  });

  it('200s with the expected shape on preprod', async () => {
    mockNetwork = { network: 'preprod', networkId: 0 };
    const res = await POST(req(USER, `constitution text ${Math.random()}`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; hashHex: string };
    expect(json.url).toBe(`ipfs://${CID}`);
    expect(json.hashHex).toMatch(/^[0-9a-f]{64}$/);
  });
});
