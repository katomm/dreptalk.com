/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for gateGovActionRequest and its per-route policies.
// network and env are injected via deps so every branch is deterministic and
// never depends on the global cloudflare:workers env (preprod-only in prod).
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { gateGovActionRequest, GOV_ACTION_RATE_POLICIES } from './govActionGate.js';
import * as rate from '../rate.js';

const preprod = { network: 'preprod', networkId: 0 } as never; // minimal NetworkConfig stub

function req(headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
  return new Request('https://dreptalk.com/api/gov-action/context', { method: 'GET', headers });
}

const withJwt = { ...env, PINATA_JWT: 'jwt' } as Cloudflare.Env;
const user = { user: { id: 'u', roles: [] } } as App.Locals;

describe('gateGovActionRequest (context policy)', () => {
  it('passes without a JWT', async () => {
    const out = await gateGovActionRequest(
      { request: req(), locals: user },
      GOV_ACTION_RATE_POLICIES.context,
      { network: preprod, env: { ...env, PINATA_JWT: undefined } as Cloudflare.Env },
    );
    expect(out instanceof Response).toBe(false);
    if (!(out instanceof Response)) {
      expect(out.jwt).toBeNull();
    }
  });

  it('still 401s when signed out', async () => {
    const out = await gateGovActionRequest(
      { request: req(), locals: { user: null } as App.Locals },
      GOV_ACTION_RATE_POLICIES.context,
      { network: preprod, env: { ...env, PINATA_JWT: undefined } as Cloudflare.Env },
    );
    expect(out instanceof Response && out.status).toBe(401);
  });
});

describe('gateGovActionRequest rate limiting', () => {
  it('passes each policy\'s rateMax to checkRate as max, one call per request', async () => {
    for (const [name, policy] of Object.entries(GOV_ACTION_RATE_POLICIES)) {
      const spy = vi.spyOn(rate, 'checkRate').mockResolvedValueOnce(true);
      const out = await gateGovActionRequest(
        { request: req(), locals: user },
        policy,
        { network: preprod, env: withJwt },
      );
      expect(out instanceof Response).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][2]).toEqual(expect.objectContaining({ max: policy.rateMax }));
      spy.mockRestore();
      void name;
    }
  });
});
