/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for gateGovActionRequest and its per-route policies.
// network and env are injected via deps so every branch is deterministic and
// never depends on the global cloudflare:workers env (preprod-only in prod).
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { gateGovActionRequest, GOV_ACTION_RATE_POLICIES, type GovActionGatePolicy } from './govActionGate.js';
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
  it('passes each policy\'s rateMax to checkRate as max, first of its calls', async () => {
    for (const policy of Object.values(GOV_ACTION_RATE_POLICIES)) {
      const spy = vi.spyOn(rate, 'checkRate').mockResolvedValue(true);
      const out = await gateGovActionRequest(
        { request: req(), locals: user },
        policy,
        { network: preprod, env: withJwt },
      );
      expect(out instanceof Response).toBe(false);
      // Without a client IP only the global budget joins the per-user limit.
      expect(spy).toHaveBeenCalledTimes('pinBudget' in policy ? 2 : 1);
      expect(spy.mock.calls[0][2]).toEqual(expect.objectContaining({ max: policy.rateMax }));
      spy.mockRestore();
    }
  });
});

const mainnet = { network: 'mainnet', networkId: 1 } as never;

describe('gateGovActionRequest on mainnet', () => {
  it('passes like on preprod and reports the mainnet network id', async () => {
    const spy = vi.spyOn(rate, 'checkRate').mockResolvedValue(true);
    const out = await gateGovActionRequest({ request: req(), locals: user }, GOV_ACTION_RATE_POLICIES.context, {
      network: mainnet,
      env: withJwt,
    });
    expect(out instanceof Response).toBe(false);
    if (!(out instanceof Response)) expect(out.networkId).toBe(1);
    spy.mockRestore();
  });
});

describe('gateGovActionRequest pin budgets', () => {
  const ipReq = () => req({ 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.7' });
  const NOW = Date.UTC(2026, 9, 18, 23, 59, 0);

  function run(request: Request, refuseKey?: string, now = NOW, policy: GovActionGatePolicy = GOV_ACTION_RATE_POLICIES.metadata) {
    const spy = vi
      .spyOn(rate, 'checkRate')
      .mockImplementation(async (_ns, key) => !(refuseKey && key.startsWith(refuseKey)));
    const out = gateGovActionRequest({ request, locals: user }, policy, { network: preprod, env: withJwt, now });
    return { spy, out };
  }

  it('checks user, then IP, then global, with daily keys and windows', async () => {
    const { spy, out } = run(ipReq());
    expect((await out) instanceof Response).toBe(false);
    expect(spy.mock.calls.map((c) => [c[1], c[2].max, c[2].windowSec])).toEqual([
      ['gov-action-meta:u', 10, 60],
      ['gov-action-pin-ip:203.0.113.7:2026-10-18', 5, 86_400],
      ['gov-action-pin-global:preprod:2026-10-18', 10, 86_400],
    ]);
    spy.mockRestore();
  });

  it('rolls both daily keys over at 00:00 UTC', async () => {
    const { spy, out } = run(ipReq(), undefined, NOW + 60_000);
    await out;
    expect(spy.mock.calls.slice(1).map((c) => c[1])).toEqual([
      'gov-action-pin-ip:203.0.113.7:2026-10-19',
      'gov-action-pin-global:preprod:2026-10-19',
    ]);
    spy.mockRestore();
  });

  it('answers 429 pin_budget_ip without spending the global budget', async () => {
    const { spy, out } = run(ipReq(), 'gov-action-pin-ip:');
    const res = (await out) as Response;
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'pin_budget_ip' });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('answers 429 pin_budget_global and warns with the network', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spy, out } = run(ipReq(), 'gov-action-pin-global:');
    const res = (await out) as Response;
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'pin_budget_global' });
    expect(warn).toHaveBeenCalledWith('[gov-action] global pin budget exhausted on preprod');
    spy.mockRestore();
    warn.mockRestore();
  });

  it('skips the IP budget without a client IP, the global one still applies', async () => {
    const { spy, out } = run(req());
    await out;
    expect(spy.mock.calls.map((c) => c[1])).toEqual(['gov-action-meta:u', 'gov-action-pin-global:preprod:2026-10-18']);
    spy.mockRestore();
  });

  it('a request the per-user limit refused spends no daily budget', async () => {
    const { spy, out } = run(ipReq(), 'gov-action-meta:');
    expect(((await out) as Response).status).toBe(429);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('answers 503 when the limiter fails on a budget check', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(rate, 'checkRate').mockImplementation(async (_ns, key) => {
      if (key.startsWith('gov-action-pin-global:')) throw new Error('DO down');
      return true;
    });
    const res = (await gateGovActionRequest({ request: ipReq(), locals: user }, GOV_ACTION_RATE_POLICIES.document, {
      network: preprod,
      env: withJwt,
      now: NOW,
    })) as Response;
    expect(res.status).toBe(503);
    spy.mockRestore();
    err.mockRestore();
  });

  it('charges no budget on the routes that never pin', async () => {
    for (const policy of [GOV_ACTION_RATE_POLICIES.prepare, GOV_ACTION_RATE_POLICIES.context, GOV_ACTION_RATE_POLICIES.status]) {
      const { spy, out } = run(ipReq(), undefined, NOW, policy);
      await out;
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }
  });
});
