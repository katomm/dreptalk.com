/// <reference types="@cloudflare/workers-types" />
// The context route under a mainnet submission switch that is ON (simulated
// here, main has no such switch yet): a treasury withdrawal must still answer
// 404 on mainnet, before the type is validated or any Koios read starts. Only
// the switch is mocked, govActionTypeAvailable is the real rule, so deleting
// its treasury line makes the first test fail while the second stays green.
// Its own file because vi.mock is file-scoped and hoisted.
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';

vi.mock('./submissionGate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./submissionGate.js')>();
  return { ...actual, govActionSubmissionAvailable: () => true };
});

const { handleActionContext } = await import('./actionContextHandler.js');

const mainnet = { network: 'mainnet', networkId: 1 } as never;
const testEnv = { ...env } as Cloudflare.Env;

function ctx(type: string) {
  const request = new Request(`https://dreptalk.com/api/gov-action/context?type=${encodeURIComponent(type)}`, {
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  return { request, locals: { user: { id: 'ctx-mainnet-user', roles: [] } } as App.Locals };
}

function koios() {
  return {
    tip: vi.fn(async () => ({ epoch_no: 600 })),
    epochParams: vi.fn(async () => null),
    lastRatifiedProposal: vi.fn(async () => []),
    openProposals: vi.fn(async () => []),
    committeeContext: vi.fn(async () => ({ members: [], quorum: null })),
  };
}

describe('handleActionContext with submission switched on for mainnet', () => {
  it.each(['TreasuryWithdrawals', 'ParameterChange'])('404s %s on mainnet without touching Koios', async (type) => {
    const k = koios();
    const res = await handleActionContext(ctx(type), { koios: k, network: mainnet, env: testEnv });
    expect(res.status).toBe(404);
    expect(k.tip).not.toHaveBeenCalled();
    expect(k.lastRatifiedProposal).not.toHaveBeenCalled();
  });

  it('still serves an available type there', async () => {
    const res = await handleActionContext(ctx('InfoAction'), { koios: koios(), network: mainnet, env: testEnv });
    expect(res.status).toBe(200);
  });

  it('still 400s an unknown type there', async () => {
    const res = await handleActionContext(ctx('Bogus'), { koios: koios(), network: mainnet, env: testEnv });
    expect(res.status).toBe(400);
  });
});
