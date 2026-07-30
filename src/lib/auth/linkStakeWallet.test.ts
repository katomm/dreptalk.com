// Node.js tests for linkStakeWallet.ts -- pure logic, no DOM.
import { describe, it, expect, vi } from 'vitest';
import { linkStakeWallet, trackDelegation } from './linkStakeWallet.js';
import type { WalletApi } from './walletLogin.js';

// ---------------------------------------------------------------------------
// Shared test doubles
// ---------------------------------------------------------------------------

const FAKE_PAYLOAD = 'dreptalk.com|link|nonce123';
const FAKE_SIG = 'deadbeef01';
const FAKE_KEY = 'cafebabe02';
const FAKE_REWARD_ADDR = 'e0aabbccdd'; // hex, as returned by CIP-30

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

// Builds a fetch mock: challenge always succeeds with FAKE_PAYLOAD, link-stake
// responds with the given status/body.
function makeFetch(linkStatus: number, linkBody: Record<string, unknown>) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const url = _url.toString();
    if (url.includes('link-challenge')) {
      return new Response(JSON.stringify({ payload: FAKE_PAYLOAD }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('link-stake')) {
      return new Response(JSON.stringify(linkBody), {
        status: linkStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('linkStakeWallet: happy path', () => {
  it('fetches the challenge, signs with the reward address, and posts the exact link-stake body', async () => {
    const fetchMock = makeFetch(200, { ok: true, linked: true });
    const api = makeApi();

    const result = await linkStakeWallet(api, 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result).toEqual({ ok: true, linked: true });

    // Challenge request.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/link-challenge',
      expect.objectContaining({ method: 'POST' }),
    );

    // Signing uses the wallet's reward address.
    expect(api.getRewardAddresses).toHaveBeenCalled();
    expect(api.signData).toHaveBeenCalledWith(FAKE_REWARD_ADDR, expect.any(String));

    // link-stake POST body carries the exact fields.
    const linkCall = fetchMock.mock.calls.find(([url]) => url.toString().includes('link-stake'));
    expect(linkCall).toBeDefined();
    const body = JSON.parse(linkCall![1]!.body as string) as Record<string, string>;
    expect(body).toEqual({ payload: FAKE_PAYLOAD, signatureHex: FAKE_SIG, keyHex: FAKE_KEY });
  });
});

describe('linkStakeWallet: challenge request fails', () => {
  it('returns an error result and never attempts to sign', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    const api = makeApi();

    const result = await linkStakeWallet(api, 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('unauthorized');
    expect(api.getRewardAddresses).not.toHaveBeenCalled();
    expect(api.signData).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the challenge error body has no error field', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 500 }));
    const api = makeApi();

    const result = await linkStakeWallet(api, 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('challenge request failed');
  });
});

describe('linkStakeWallet: wallet has no reward address', () => {
  it('returns an error result without calling signData', async () => {
    const fetchMock = makeFetch(200, { ok: true, linked: true });
    const api = makeApi({ getRewardAddresses: vi.fn(async () => []) });

    const result = await linkStakeWallet(api, 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result).toEqual({ ok: false, error: 'wallet has no reward address' });
    expect(api.signData).not.toHaveBeenCalled();
  });
});

describe('linkStakeWallet: signData throws', () => {
  it('returns an error result when the user declines to sign', async () => {
    const fetchMock = makeFetch(200, { ok: true, linked: true });
    const api = makeApi({
      signData: vi.fn(async () => {
        throw { code: 3, info: 'User declined to sign the data.' };
      }),
    });

    const result = await linkStakeWallet(api, 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('User declined to sign the data.');
  });
});

describe('linkStakeWallet: distinct link-stake server error shapes', () => {
  // The lib itself does no error-string mapping (that lives in the
  // LinkStakeWallet.tsx island's friendlyLinkError); it just passes the
  // server's raw error string through. These are the actual strings
  // produced by handleLinkStake in linkStake.ts.
  it.each([
    ['invalid or expired nonce', 401],
    ['signature verification failed', 401],
    ['stake wallet already linked to another account', 409],
    ['account already has a stake wallet', 409],
    ['unauthorized', 401],
  ])('passes through "%s" (HTTP %i) unmodified', async (serverError, status) => {
    const fetchMock = makeFetch(status, { ok: false, error: serverError });
    const api = makeApi();

    const result = await linkStakeWallet(api, 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result).toEqual({ ok: false, error: serverError });
  });

  it('falls back to a status-coded message when the response has no JSON body', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => {
      const url = _url.toString();
      if (url.includes('link-challenge')) {
        return new Response(JSON.stringify({ payload: FAKE_PAYLOAD }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('service unavailable', { status: 503 });
    });
    const api = makeApi();

    const result = await linkStakeWallet(api, 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result).toEqual({ ok: false, error: 'link failed (HTTP 503)' });
  });
});

describe('linkStakeWallet: wallet network guard', () => {
  it('fails fast with a clear message when the wallet is on the wrong network, before burning the nonce', async () => {
    const fetchMock = makeFetch(200, { ok: true, linked: true });
    // Wallet reports mainnet (1) while the app runs on preprod.
    const api = makeApi({ getNetworkId: vi.fn(async () => 1) });

    const result = await linkStakeWallet(api, 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Your wallet is on Mainnet');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.signData).not.toHaveBeenCalled();
  });

  it('proceeds when the wallet does not expose getNetworkId', async () => {
    const fetchMock = makeFetch(200, { ok: true, linked: true });
    const api = makeApi(); // no getNetworkId

    const result = await linkStakeWallet(api, 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// trackDelegation
// ---------------------------------------------------------------------------

describe('trackDelegation', () => {
  it('returns the resolved tracking result on success', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, status: 'resolved', delegationType: 'drep', drepId: 'drep1xyz' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await trackDelegation({ fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result).toEqual({ ok: true, status: 'resolved', delegationType: 'drep', drepId: 'drep1xyz' });
    expect(fetchMock).toHaveBeenCalledWith('/api/delegation/track', { method: 'POST' });
  });

  it('returns an error result when the server responds with a failure', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: 'no stake wallet linked' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const result = await trackDelegation({ fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result).toEqual({ ok: false, error: 'no stake wallet linked' });
  });

  it('returns an error result when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });

    const result = await trackDelegation({ fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('network down');
  });
});
