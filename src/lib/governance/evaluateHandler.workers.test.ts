/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for handleEvaluate: the shared gate with the evaluate
// policy, the body cap, the transaction checks that keep the route to the
// guardrail script alone, the forward to Koios /ogmios and the mapping of
// every upstream answer to the route's typed contract.
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { CBOR, ProtocolParamUpdate } from '@evolution-sdk/evolution';
import { handleEvaluate, EVALUATE_BODY_MAX_BYTES } from './evaluateHandler.js';
import { GOV_ACTION_RATE_POLICIES } from './govActionGate.js';
import * as rate from '../rate.js';
import {
  FOREIGN_PLUTUS_SCRIPT,
  buildEvalTxHex,
  guardrailPlutusFixture,
  infoProposal,
  paramChangeProposal,
  treasuryProposal,
} from './__fixtures__/evaluateTx.js';

const preprod = { network: 'preprod', networkId: 0 } as never;
const mainnet = { network: 'mainnet', networkId: 1 } as never;
const testEnv = { ...env } as Cloudflare.Env;
const KOIOS = 'https://preprod.koios.rest/api/v1';

// A fresh user per request: the evaluate policy allows 20 per minute and this
// file sends more than that.
function ctx(body: string | null, opts: { user?: boolean; headers?: Record<string, string> } = {}) {
  const request = new Request('https://dreptalk.com/api/gov-action/evaluate', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...opts.headers },
    body,
  });
  const user = opts.user === false ? null : { id: crypto.randomUUID(), roles: [] };
  return { request, locals: { user } as App.Locals };
}

function upstream(status: number, body: unknown) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

const OGMIOS_OK = {
  jsonrpc: '2.0',
  method: 'evaluateTransaction',
  result: [{ validator: { purpose: 'propose', index: 0 }, budget: { memory: 1000, cpu: 2000 } }],
  id: null,
};
const OGMIOS_SCRIPT_FAILURE = {
  jsonrpc: '2.0',
  method: 'evaluateTransaction',
  error: { code: 3010, message: 'Some scripts of the transactions terminated with error(s).', data: [] },
  id: null,
};

function deps(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return { network: preprod, env: testEnv, koiosBaseUrl: KOIOS, koiosToken: 'tok', fetchImpl, ...extra };
}

describe('handleEvaluate gate', () => {
  it('404s on mainnet', async () => {
    const fetchImpl = upstream(200, OGMIOS_OK);
    const res = await handleEvaluate(ctx(JSON.stringify({ txCborHex: buildEvalTxHex() })), deps(fetchImpl, { network: mainnet }));
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('401s when signed out', async () => {
    const res = await handleEvaluate(ctx('{}', { user: false }), deps(upstream(200, OGMIOS_OK)));
    expect(res.status).toBe(401);
  });

  it('applies the evaluate policy, 20 per minute', async () => {
    expect(GOV_ACTION_RATE_POLICIES.evaluate).toEqual({
      rateKey: 'gov-action-eval',
      rateMax: 20,
      rateWindowSec: 60,
      requireJwt: false,
    });
    const spy = vi.spyOn(rate, 'checkRate').mockResolvedValueOnce(false);
    const res = await handleEvaluate(ctx(JSON.stringify({ txCborHex: buildEvalTxHex() })), deps(upstream(200, OGMIOS_OK)));
    expect(res.status).toBe(429);
    expect(spy.mock.calls[0][2]).toEqual(expect.objectContaining({ max: 20 }));
    spy.mockRestore();
  });
});

describe('handleEvaluate body', () => {
  // One case only: a hand-set Content-Length on a Request may be replaced by
  // workerd, so the cap is tested through the bounded reader with a body that
  // understates its length. The handler's early header check stays as a fast
  // path without a test of its own.
  it('413s an oversized body whatever length it declares', async () => {
    const body = JSON.stringify({ txCborHex: 'ab'.repeat(EVALUATE_BODY_MAX_BYTES) });
    const res = await handleEvaluate(ctx(body, { headers: { 'content-length': '10' } }), deps(upstream(200, OGMIOS_OK)));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'body_too_large' });
  });

  it('400s a body that is not the expected JSON, without an upstream call', async () => {
    const fetchImpl = upstream(200, OGMIOS_OK);
    const bodies = [
      'not json',
      '{}',
      JSON.stringify({ txCborHex: 42 }),
      JSON.stringify({ txCborHex: 'abc' }),
      JSON.stringify({ txCborHex: 'zz' }),
      JSON.stringify({ txCborHex: 'ABCD' }),
      JSON.stringify({ txCborHex: '' }),
    ];
    for (const body of bodies) {
      const res = await handleEvaluate(ctx(body), deps(fetchImpl));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('400s hex that is no transaction', async () => {
    const res = await handleEvaluate(ctx(JSON.stringify({ txCborHex: '00ff' })), deps(upstream(200, OGMIOS_OK)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_transaction' });
  });
});

describe('handleEvaluate transaction checks', () => {
  async function rejected(txCborHex: string) {
    const fetchImpl = upstream(200, OGMIOS_OK);
    const res = await handleEvaluate(ctx(JSON.stringify({ txCborHex })), deps(fetchImpl));
    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    return ((await res.json()) as { error: string }).error;
  }

  it('rejects a transaction without proposals', async () => {
    expect(await rejected(buildEvalTxHex({ proposals: [] }))).toBe('no_proposals');
  });

  it('rejects any redeemer that is not a propose redeemer', async () => {
    expect(await rejected(buildEvalTxHex({ redeemerTags: ['spend'] }))).toBe('non_propose_redeemer');
    expect(await rejected(buildEvalTxHex({ redeemerTags: ['propose', 'mint'] }))).toBe('non_propose_redeemer');
  });

  it('rejects a proposal whose policy hash is not the guardrail', async () => {
    expect(await rejected(buildEvalTxHex({ proposals: [treasuryProposal('ab'.repeat(28))] }))).toBe('foreign_policy_hash');
  });

  it('rejects a foreign Plutus script next to the guardrail', async () => {
    expect(await rejected(buildEvalTxHex({ scripts: [guardrailPlutusFixture(), FOREIGN_PLUTUS_SCRIPT] }))).toBe('foreign_script');
  });

  it('rejects a parameter change that touches a parameter DRepTalk does not offer', async () => {
    const update = new ProtocolParamUpdate.ProtocolParamUpdate({ nOpt: 600n, maxTxSize: 20_000n });
    expect(await rejected(buildEvalTxHex({ proposals: [paramChangeProposal(update)] }))).toBe('unsupported_parameter_change');
  });

  it('rejects a parameter change outside the constitution bounds', async () => {
    const update = new ProtocolParamUpdate.ProtocolParamUpdate({ nOpt: 2001n });
    expect(await rejected(buildEvalTxHex({ proposals: [paramChangeProposal(update)] }))).toBe('unsupported_parameter_change');
  });

  it('rejects a parameter change whose raw bytes carry a key the SDK decoder drops', async () => {
    // Splice key 99 into the update map of an otherwise valid transaction.
    const tx = CBOR.fromCBORHex(buildEvalTxHex({ proposals: [paramChangeProposal()] })) as CBOR.CBOR[];
    const body = tx[0] as Map<CBOR.CBOR, CBOR.CBOR>;
    const raw = body.get(20n) as CBOR.CBOR;
    const list = (raw !== null && typeof raw === 'object' && '_tag' in raw ? (raw as { value: CBOR.CBOR[] }).value : raw) as CBOR.CBOR[][];
    const action = list[0][2] as CBOR.CBOR[];
    action[2] = new Map<CBOR.CBOR, CBOR.CBOR>([...(action[2] as Map<CBOR.CBOR, CBOR.CBOR>), [99n, 1n]]);
    expect(await rejected(CBOR.toCBORHex(tx))).toBe('unsupported_parameter_change');
  });

  it('accepts a parameter change of the offered parameters', async () => {
    const txCborHex = buildEvalTxHex({ proposals: [paramChangeProposal()] });
    const res = await handleEvaluate(ctx(JSON.stringify({ txCborHex })), deps(upstream(200, OGMIOS_OK)));
    expect(res.status).toBe(200);
  });

  it('accepts a null policy hash and an info proposal next to the guardrail one', async () => {
    const txCborHex = buildEvalTxHex({ proposals: [treasuryProposal(), infoProposal(), treasuryProposal(null)] });
    const res = await handleEvaluate(ctx(JSON.stringify({ txCborHex })), deps(upstream(200, OGMIOS_OK)));
    expect(res.status).toBe(200);
  });
});

describe('handleEvaluate upstream', () => {
  it('forwards the original hex to /ogmios with the server token and maps the result', async () => {
    const fetchImpl = upstream(200, OGMIOS_OK);
    const txCborHex = buildEvalTxHex();
    const res = await handleEvaluate(ctx(JSON.stringify({ txCborHex })), deps(fetchImpl));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      redeemers: [{ redeemer_tag: 'propose', redeemer_index: 0, ex_units: { mem: '1000', steps: '2000' } }],
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${KOIOS}/ogmios`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(init?.body))).toEqual({
      jsonrpc: '2.0',
      method: 'evaluateTransaction',
      params: { transaction: { cbor: txCborHex }, additionalUtxo: [] },
      id: null,
    });
  });

  it('sends no authorization header without a token', async () => {
    const fetchImpl = upstream(200, OGMIOS_OK);
    await handleEvaluate(ctx(JSON.stringify({ txCborHex: buildEvalTxHex() })), deps(fetchImpl, { koiosToken: undefined }));
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
  });

  it('maps a script failure (3010) to evaluation_failed whatever the HTTP status', async () => {
    for (const status of [200, 400]) {
      const res = await handleEvaluate(
        ctx(JSON.stringify({ txCborHex: buildEvalTxHex() })),
        deps(upstream(status, OGMIOS_SCRIPT_FAILURE)),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; detail: string };
      expect(body.error).toBe('evaluation_failed');
      expect(body.detail).toContain('Some scripts of the transactions terminated with error(s).');
    }
  });

  it('answers evaluator_unavailable for a JSON-RPC error that is no script failure', async () => {
    const answers = [
      upstream(400, { jsonrpc: '2.0', method: 'evaluateTransaction', error: { code: -32602, message: 'Invalid transaction' }, id: null }),
      upstream(200, { jsonrpc: '2.0', method: 'evaluateTransaction', error: { code: 3004, message: 'Cannot create evaluation context' }, id: null }),
      upstream(400, { jsonrpc: '2.0', method: 'evaluateTransaction', error: { code: 3003, message: 'Node tip too old' }, id: null }),
    ];
    for (const fetchImpl of answers) {
      const res = await handleEvaluate(ctx(JSON.stringify({ txCborHex: buildEvalTxHex() })), deps(fetchImpl));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'evaluator_unavailable' });
    }
  });

  it('answers evaluator_unavailable for a network error, a 5xx, HTML, a 429 or an unknown JSON shape', async () => {
    const answers: (typeof fetch)[] = [
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
      upstream(502, '<html>bad gateway</html>'),
      upstream(500, OGMIOS_SCRIPT_FAILURE),
      upstream(200, 'not json'),
      upstream(200, { jsonrpc: '2.0' }),
      upstream(429, { error: 'rate limited' }),
    ];
    for (const fetchImpl of answers) {
      const res = await handleEvaluate(ctx(JSON.stringify({ txCborHex: buildEvalTxHex() })), deps(fetchImpl));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'evaluator_unavailable' });
    }
  });
});
