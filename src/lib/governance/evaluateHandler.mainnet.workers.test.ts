/// <reference types="@cloudflare/workers-types" />
// The evaluate route under a mainnet submission switch that is ON (simulated
// here, main has no such switch yet): a treasury evaluation must still answer
// 404 on mainnet, before the body is read or Koios is called. Only the switch
// is mocked, govActionTypeAvailable is the real rule, so deleting its treasury
// line makes the first test fail while the controls stay green.
// Its own file because vi.mock is file-scoped and hoisted.
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';

vi.mock('./submissionGate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./submissionGate.js')>();
  return { ...actual, govActionSubmissionAvailable: () => true };
});

const { handleEvaluate } = await import('./evaluateHandler.js');
const { buildEvalTxHex, paramChangeProposal } = await import('./__fixtures__/evaluateTx.js');

const mainnet = { network: 'mainnet', networkId: 1 } as never;
const preprod = { network: 'preprod', networkId: 0 } as never;
const testEnv = { ...env } as Cloudflare.Env;

const OGMIOS_OK = {
  jsonrpc: '2.0',
  method: 'evaluateTransaction',
  result: [{ validator: { purpose: 'propose', index: 0 }, budget: { memory: 1000, cpu: 2000 } }],
  id: null,
};

function ctx(user: boolean = true, txCborHex: string = buildEvalTxHex()) {
  const request = new Request('https://dreptalk.com/api/gov-action/evaluate', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ txCborHex }),
  });
  return { request, locals: { user: user ? { id: crypto.randomUUID(), roles: [] } : null } as App.Locals };
}

function upstream() {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(OGMIOS_OK), { status: 200 }));
}

function deps(network: never, fetchImpl: typeof fetch) {
  return { network, env: testEnv, koiosBaseUrl: 'https://koios.example/api/v1', koiosToken: 'tok', fetchImpl };
}

describe('handleEvaluate with submission switched on for mainnet', () => {
  it('404s a treasury evaluation on mainnet without calling Koios', async () => {
    const fetchImpl = upstream();
    const res = await handleEvaluate(ctx(), deps(mainnet, fetchImpl));
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('404s a parameter change evaluation on mainnet without calling Koios', async () => {
    const fetchImpl = upstream();
    const res = await handleEvaluate(ctx(true, buildEvalTxHex({ proposals: [paramChangeProposal()] })), deps(mainnet, fetchImpl));
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets the gate through on mainnet, so the 404 above is the type rule', async () => {
    const res = await handleEvaluate(ctx(false), deps(mainnet, upstream()));
    expect(res.status).toBe(401);
  });

  it('still evaluates the same request on preprod', async () => {
    const fetchImpl = upstream();
    const res = await handleEvaluate(ctx(), deps(preprod, fetchImpl));
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
