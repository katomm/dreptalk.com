/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for gateInfoActionRequest, the shared server gate for
// POST /api/gov-action/metadata and POST /api/gov-action/metadata/prepare.
// network and env are injected via deps so every branch is deterministic and
// never depends on the global cloudflare:workers env (preprod-only in prod).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { gateInfoActionRequest } from '../metadata.js';

const preprod = { network: 'preprod', networkId: 0 } as never; // minimal NetworkConfig stub
const mainnet = { network: 'mainnet', networkId: 1 } as never;

function req(headers: Record<string, string>) {
  return new Request('https://dreptalk.com/api/gov-action/metadata', { method: 'POST', headers });
}

const withJwt = { ...env, PINATA_JWT: 'jwt' } as Cloudflare.Env;

describe('gateInfoActionRequest', () => {
  const user = { user: { id: 'u', roles: [] } } as App.Locals;

  it('404 on mainnet', async () => {
    const out = await gateInfoActionRequest(
      { request: req({ 'sec-fetch-site': 'same-origin' }), locals: user },
      { network: mainnet, env: withJwt },
    );
    expect(out instanceof Response && out.status).toBe(404);
  });

  it('403 cross-origin', async () => {
    const out = await gateInfoActionRequest(
      { request: req({ 'sec-fetch-site': 'cross-site' }), locals: user },
      { network: preprod, env: withJwt },
    );
    expect(out instanceof Response && out.status).toBe(403);
  });

  it('401 signed out', async () => {
    const out = await gateInfoActionRequest(
      { request: req({ 'sec-fetch-site': 'same-origin' }), locals: { user: null } as App.Locals },
      { network: preprod, env: withJwt },
    );
    expect(out instanceof Response && out.status).toBe(401);
  });

  it('503 without PINATA_JWT', async () => {
    const out = await gateInfoActionRequest(
      { request: req({ 'sec-fetch-site': 'same-origin' }), locals: user },
      { network: preprod, env: { ...env, PINATA_JWT: undefined } as Cloudflare.Env },
    );
    expect(out instanceof Response && out.status).toBe(503);
  });

  it('passes with everything present', async () => {
    const out = await gateInfoActionRequest(
      { request: req({ 'sec-fetch-site': 'same-origin' }), locals: user },
      { network: preprod, env: withJwt },
    );
    expect(out instanceof Response).toBe(false);
  });
});
