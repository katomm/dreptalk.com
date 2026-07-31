// Node.js tests for redeemCoProposer.ts -- pure logic, no DOM.
import { describe, it, expect, vi } from 'vitest';
import { redeemCoProposerInvite, friendlyRedeemError } from './redeemCoProposer.js';
import type { WalletApi } from './walletLogin.js';

// ---------------------------------------------------------------------------
// Shared test doubles
// ---------------------------------------------------------------------------

const FAKE_CODE = 'abc123code';
const FAKE_PAYLOAD = 'dreptalk.com|co-proposer-redeem|nonce123';
const FAKE_SIG = 'deadbeef01';
const FAKE_KEY = 'cafebabe02';
const FAKE_REWARD_ADDR = 'e0aabbccdd'; // hex, as returned by CIP-30
const FAKE_NAME = 'Ada Lovelace';

function makeApi(overrides?: Partial<WalletApi>): WalletApi {
  return {
    getRewardAddresses: vi.fn(async () => [FAKE_REWARD_ADDR]),
    signData: vi.fn(async (_addr: string, _payloadHex: string) => ({
      signature: FAKE_SIG,
      key: FAKE_KEY,
    })),
    ...overrides,
  };
}

// Builds a fetch mock: challenge always succeeds with FAKE_PAYLOAD, redeem
// responds with the given status/body.
function makeFetch(redeemStatus: number, redeemBody: Record<string, unknown>) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const url = _url.toString();
    if (url.includes('co-proposer/challenge')) {
      return new Response(JSON.stringify({ payload: FAKE_PAYLOAD }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('co-proposer/redeem')) {
      return new Response(JSON.stringify(redeemBody), {
        status: redeemStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

// ---------------------------------------------------------------------------
// redeemCoProposerInvite
// ---------------------------------------------------------------------------

describe('redeemCoProposerInvite: happy path', () => {
  it('fetches the challenge with the code, signs with the reward address, and posts the exact redeem body', async () => {
    const fetchMock = makeFetch(200, { ok: true, user: { id: 'u1', roles: ['proposer'] } });
    const api = makeApi();

    const result = await redeemCoProposerInvite(api, 'preprod', FAKE_CODE, FAKE_NAME, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true });

    // Challenge request carries the code, never a grantId.
    const challengeCall = fetchMock.mock.calls.find(([url]) => url.toString().includes('co-proposer/challenge'));
    expect(challengeCall).toBeDefined();
    expect(JSON.parse(challengeCall![1]!.body as string)).toEqual({ code: FAKE_CODE });

    // Signing uses the wallet's reward address.
    expect(api.getRewardAddresses).toHaveBeenCalled();
    expect(api.signData).toHaveBeenCalledWith(FAKE_REWARD_ADDR, expect.any(String));

    // Redeem POST body carries the exact fields.
    const redeemCall = fetchMock.mock.calls.find(([url]) => url.toString().includes('co-proposer/redeem'));
    expect(redeemCall).toBeDefined();
    const body = JSON.parse(redeemCall![1]!.body as string) as Record<string, string>;
    expect(body).toEqual({
      code: FAKE_CODE,
      payload: FAKE_PAYLOAD,
      signatureHex: FAKE_SIG,
      keyHex: FAKE_KEY,
      displayName: FAKE_NAME,
    });
  });
});

describe('redeemCoProposerInvite: challenge request fails', () => {
  it('returns an error result and never attempts to sign', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => {
      return new Response(JSON.stringify({ ok: false, error: 'invite unavailable' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    const api = makeApi();

    const result = await redeemCoProposerInvite(api, 'preprod', FAKE_CODE, FAKE_NAME, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: 'invite unavailable' });
    expect(api.getRewardAddresses).not.toHaveBeenCalled();
    expect(api.signData).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the challenge error body has no error field', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 500 }));
    const api = makeApi();

    const result = await redeemCoProposerInvite(api, 'preprod', FAKE_CODE, FAKE_NAME, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: 'challenge request failed' });
  });
});

describe('redeemCoProposerInvite: wallet has no reward address', () => {
  it('returns an error result without calling signData', async () => {
    const fetchMock = makeFetch(200, { ok: true, user: { id: 'u1', roles: ['proposer'] } });
    const api = makeApi({ getRewardAddresses: vi.fn(async () => []) });

    const result = await redeemCoProposerInvite(api, 'preprod', FAKE_CODE, FAKE_NAME, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: 'wallet has no reward address' });
    expect(api.signData).not.toHaveBeenCalled();
  });
});

describe('redeemCoProposerInvite: signData throws', () => {
  it('returns an error result when the user declines to sign', async () => {
    const fetchMock = makeFetch(200, { ok: true, user: { id: 'u1', roles: ['proposer'] } });
    const api = makeApi({
      signData: vi.fn(async () => {
        throw { code: 3, info: 'User declined to sign the data.' };
      }),
    });

    const result = await redeemCoProposerInvite(api, 'preprod', FAKE_CODE, FAKE_NAME, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('User declined to sign the data.');
  });
});

describe('redeemCoProposerInvite: distinct redeem server error shapes', () => {
  // The lib itself does no error-string mapping (that lives in
  // friendlyRedeemError); it just passes the server's raw error string
  // through. These are the actual strings produced by handleRedeemGrant in
  // coProposerRedeem.ts.
  it.each([
    ['invalid or expired nonce', 401],
    ['signature verification failed', 401],
    ['mandate_taken', 409],
    ['cannot invite yourself', 400],
    ['invite unavailable', 410],
  ])('passes through "%s" (HTTP %i) unmodified', async (serverError, status) => {
    const fetchMock = makeFetch(status, { ok: false, error: serverError });
    const api = makeApi();

    const result = await redeemCoProposerInvite(api, 'preprod', FAKE_CODE, FAKE_NAME, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: serverError });
  });

  it('falls back to a status-coded message when the response has no JSON body', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => {
      const url = _url.toString();
      if (url.includes('co-proposer/challenge')) {
        return new Response(JSON.stringify({ payload: FAKE_PAYLOAD }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('service unavailable', { status: 503 });
    });
    const api = makeApi();

    const result = await redeemCoProposerInvite(api, 'preprod', FAKE_CODE, FAKE_NAME, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: 'redeem failed (HTTP 503)' });
  });
});

describe('redeemCoProposerInvite: wallet network guard', () => {
  it('fails fast with a clear message when the wallet is on the wrong network, before burning the nonce', async () => {
    const fetchMock = makeFetch(200, { ok: true, user: { id: 'u1', roles: ['proposer'] } });
    // Wallet reports mainnet (1) while the app runs on preprod.
    const api = makeApi({ getNetworkId: vi.fn(async () => 1) });

    const result = await redeemCoProposerInvite(api, 'preprod', FAKE_CODE, FAKE_NAME, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Your wallet is on Mainnet');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.signData).not.toHaveBeenCalled();
  });

  it('proceeds when the wallet does not expose getNetworkId', async () => {
    const fetchMock = makeFetch(200, { ok: true, user: { id: 'u1', roles: ['proposer'] } });
    const api = makeApi(); // no getNetworkId

    const result = await redeemCoProposerInvite(api, 'preprod', FAKE_CODE, FAKE_NAME, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// friendlyRedeemError
// ---------------------------------------------------------------------------

describe('friendlyRedeemError', () => {
  it('maps an expired/unknown invite', () => {
    expect(friendlyRedeemError('invite unavailable', 'preprod')).toContain('no longer valid');
  });

  it('maps a wallet that already holds a mandate', () => {
    expect(friendlyRedeemError('mandate_taken', 'preprod')).toContain('already writes for a proposer');
  });

  it('maps a self-invite', () => {
    expect(friendlyRedeemError('cannot invite yourself', 'preprod')).toBe('You cannot accept your own invite.');
  });

  it('maps a wallet-network mismatch to the shared human message', () => {
    const msg = friendlyRedeemError('wallet network mismatch', 'preprod');
    expect(msg).toContain('Preprod');
  });

  it('falls back to a sentence-cased, punctuated version of an unrecognized error', () => {
    expect(friendlyRedeemError('some odd server error', 'preprod')).toBe('Some odd server error.');
  });

  it('has a default message for an empty error', () => {
    expect(friendlyRedeemError(undefined, 'preprod')).toBe('Could not join. Please try again.');
  });
});
