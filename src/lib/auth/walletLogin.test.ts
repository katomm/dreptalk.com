// Node.js tests for walletLogin.ts -- pure logic, no DOM.
import { describe, it, expect, vi } from 'vitest';
import { loginWithWallet } from './walletLogin.js';
import type { WalletApi } from './walletLogin.js';
import { blake2b224 } from '../crypto/blake.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';

// The bare DRep key hash (CIP-95 DRepID) the flow offers first: blake2b-224 of
// the raw 32-byte DRep public key, hex-encoded (28 bytes = 56 hex chars).
const FAKE_DREP_KEYHASH = bytesToHex(blake2b224(hexToBytes('a'.repeat(64))));

// ---------------------------------------------------------------------------
// Shared test doubles
// ---------------------------------------------------------------------------

const FAKE_PAYLOAD = 'dreptalk.com|nonce|abc123';
const FAKE_SIG = 'deadbeef01';
const FAKE_KEY = 'cafebabe02';
const FAKE_REWARD_ADDR = 'e0aabbccdd'; // hex, as returned by CIP-30
const FAKE_DREP_PUBKEY = 'a'.repeat(64); // 32 bytes hex

const FAKE_USER = { id: 'usr_01', roles: ['proposer'] };
const FAKE_USER_DREP = { id: 'usr_02', roles: ['drep'] };

function makeFetch(challengePayload: string, verifyOk: boolean, verifyStatus = 200) {
  let callCount = 0;
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    callCount++;
    const url = _url.toString();
    if (url.includes('challenge')) {
      return new Response(JSON.stringify({ payload: challengePayload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('verify')) {
      const user = callCount <= 2 ? FAKE_USER : FAKE_USER_DREP;
      return new Response(
        JSON.stringify(verifyOk ? { ok: true, user } : { ok: false, error: 'invalid' }),
        {
          status: verifyStatus,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

function makeProposerApi(overrides?: Partial<WalletApi>): WalletApi {
  return {
    getRewardAddresses: vi.fn(async () => [FAKE_REWARD_ADDR]),
    signData: vi.fn(async (_addr: string, _payloadHex: string) => ({
      signature: FAKE_SIG,
      key: FAKE_KEY,
    })),
    ...overrides,
  };
}

function makeDRepApi(overrides?: Partial<WalletApi>): WalletApi {
  return {
    getRewardAddresses: vi.fn(async () => [FAKE_REWARD_ADDR]),
    signData: vi.fn(async (_addr: string, _payloadHex: string) => ({
      signature: FAKE_SIG,
      key: FAKE_KEY,
    })),
    cip95: {
      getPubDRepKey: vi.fn(async () => FAKE_DREP_PUBKEY),
      signData: vi.fn(async (_addr: string, _payloadHex: string) => ({
        signature: FAKE_SIG,
        key: FAKE_KEY,
      })),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loginWithWallet: proposer happy path', () => {
  it('posts the right verify body and returns the user', async () => {
    const fetchMock = makeFetch(FAKE_PAYLOAD, true);
    const api = makeProposerApi();

    const result = await loginWithWallet(api, 'proposer', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    expect(result.user).toEqual(FAKE_USER);

    // Verify the challenge request.
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/challenge', expect.objectContaining({ method: 'POST' }));

    // Verify the verify POST body.
    const verifyCall = fetchMock.mock.calls.find(([url]) => url.toString().includes('verify'));
    expect(verifyCall).toBeDefined();
    const body = JSON.parse(verifyCall![1]!.body as string) as Record<string, string>;

    // The payload passed to verify must be the exact string from the challenge.
    expect(body.payload).toBe(FAKE_PAYLOAD);
    expect(body.role).toBe('proposer');
    expect(body.signatureHex).toBe(FAKE_SIG);
    expect(body.keyHex).toBe(FAKE_KEY);

    // The signing address must be the reward address.
    expect(api.signData).toHaveBeenCalledWith(
      FAKE_REWARD_ADDR,
      expect.any(String), // payloadHex
    );
  });

  it('hex-encodes the payload string correctly before signing', async () => {
    const fetchMock = makeFetch(FAKE_PAYLOAD, true);
    const api = makeProposerApi();

    await loginWithWallet(api, 'proposer', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    const signCall = (api.signData as ReturnType<typeof vi.fn>).mock.calls[0];
    const payloadHex = signCall[1] as string;

    // Decode the hex and compare with the original payload string (UTF-8).
    const bytes = new Uint8Array(payloadHex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(payloadHex.slice(i * 2, i * 2 + 2), 16);
    }
    expect(new TextDecoder().decode(bytes)).toBe(FAKE_PAYLOAD);
  });
});

function makeDRepFetch() {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const url = _url.toString();
    if (url.includes('challenge')) {
      return new Response(JSON.stringify({ payload: FAKE_PAYLOAD }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, user: FAKE_USER_DREP }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('loginWithWallet: drep happy path', () => {
  it('signs the bare CIP-95 DRep key hash via cip95.signData', async () => {
    const fetchMock = makeDRepFetch();
    const api = makeDRepApi();

    const result = await loginWithWallet(api, 'drep', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    expect(result.user).toEqual(FAKE_USER_DREP);

    // CIP-95 signData is preferred and is offered the bare DRep key hash first
    // (the literal CIP-95 DRepID: 28 bytes = 56 hex, no network header). The
    // wallet accepts it, so only one signing attempt is made.
    const signCalls = (api.cip95!.signData as ReturnType<typeof vi.fn>).mock.calls;
    expect(signCalls).toHaveLength(1);
    const addrUsed = signCalls[0][0] as string;
    expect(addrUsed).toBe(FAKE_DREP_KEYHASH);
    expect(addrUsed).toHaveLength(56);
    expect(addrUsed).not.toBe(FAKE_REWARD_ADDR);
    // The base signData must not be used when cip95.signData exists.
    expect(api.signData).not.toHaveBeenCalled();

    const verifyCall = fetchMock.mock.calls.find(([url]) => url.toString().includes('verify'));
    const body = JSON.parse(verifyCall![1]!.body as string) as Record<string, string>;
    expect(body.role).toBe('drep');
  });

  it('falls back to the type-6 enterprise address when the wallet rejects the bare key hash', async () => {
    const fetchMock = makeDRepFetch();
    // First attempt (bare DRep key hash) fails with a non-decline error, as a
    // wallet that only signs the type-6 address form would report.
    const signData = vi
      .fn()
      .mockRejectedValueOnce({ code: 2, info: 'MessageError: User rejected' })
      .mockResolvedValueOnce({ signature: FAKE_SIG, key: FAKE_KEY });
    const api = makeDRepApi({
      cip95: { getPubDRepKey: vi.fn(async () => FAKE_DREP_PUBKEY), signData },
    });

    const result = await loginWithWallet(api, 'drep', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    // Two attempts: bare key hash, then the type-6 enterprise address (58 hex,
    // preprod header 0x60).
    expect(signData).toHaveBeenCalledTimes(2);
    expect(signData.mock.calls[0][0]).toBe(FAKE_DREP_KEYHASH);
    const fallbackAddr = signData.mock.calls[1][0] as string;
    expect(fallbackAddr).toHaveLength(58);
    expect(fallbackAddr.slice(0, 2)).toBe('60');
    expect(fallbackAddr.slice(2)).toBe(FAKE_DREP_KEYHASH);
  });

  it('uses the mainnet enterprise header 0x61 for the fallback on mainnet', async () => {
    const fetchMock = makeDRepFetch();
    const signData = vi
      .fn()
      .mockRejectedValueOnce({ code: 2, info: 'MessageError' })
      .mockResolvedValueOnce({ signature: FAKE_SIG, key: FAKE_KEY });
    const api = makeDRepApi({
      cip95: { getPubDRepKey: vi.fn(async () => FAKE_DREP_PUBKEY), signData },
    });

    await loginWithWallet(api, 'drep', 'mainnet', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect((signData.mock.calls[1][0] as string).slice(0, 2)).toBe('61');
  });

  it('stops at the user decline and does not try the fallback form', async () => {
    const fetchMock = makeDRepFetch();
    // CIP-30 DataSignError UserDeclined (code 3): the user said no.
    const signData = vi.fn().mockRejectedValue({ code: 3, info: 'User declined to sign the data.' });
    const api = makeDRepApi({
      cip95: { getPubDRepKey: vi.fn(async () => FAKE_DREP_PUBKEY), signData },
    });

    const result = await loginWithWallet(api, 'drep', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    // Only the first form is attempted; an explicit decline is not retried.
    expect(signData).toHaveBeenCalledTimes(1);
  });

  it('falls back to base signData when cip95.signData is absent', async () => {
    const fetchMock = makeDRepFetch();
    const api = makeDRepApi({ cip95: { getPubDRepKey: vi.fn(async () => FAKE_DREP_PUBKEY) } });

    const result = await loginWithWallet(api, 'drep', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(true);
    const signCall = (api.signData as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(signCall[0] as string).toBe(FAKE_DREP_KEYHASH);
  });
});

describe('loginWithWallet: drep without CIP-95', () => {
  it('returns ok:false with wallet error when cip95 is absent', async () => {
    const fetchMock = makeFetch(FAKE_PAYLOAD, true);
    // api has no cip95 property.
    const api: WalletApi = {
      getRewardAddresses: vi.fn(async () => [FAKE_REWARD_ADDR]),
      signData: vi.fn(async () => ({ signature: FAKE_SIG, key: FAKE_KEY })),
    };

    const result = await loginWithWallet(api, 'drep', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('CIP-95');
    // signData must NOT have been called.
    expect(api.signData).not.toHaveBeenCalled();
  });
});

describe('loginWithWallet: wallet signData rejection', () => {
  it('returns ok:false when signData throws', async () => {
    const fetchMock = makeFetch(FAKE_PAYLOAD, true);
    const api = makeProposerApi({
      signData: vi.fn(async () => {
        throw new Error('user cancelled');
      }),
    });

    const result = await loginWithWallet(api, 'proposer', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
  });
});

describe('loginWithWallet: verify 401', () => {
  it('returns ok:false when the verify endpoint returns 401', async () => {
    const fetchMock = makeFetch(FAKE_PAYLOAD, false, 401);
    const api = makeProposerApi();

    const result = await loginWithWallet(api, 'proposer', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('loginWithWallet: wallet network guard', () => {
  it('fails fast with a clear message when the wallet is on the wrong network', async () => {
    const fetchMock = makeFetch(FAKE_PAYLOAD, true);
    // Wallet reports mainnet (1) while the app runs on preprod.
    const api = makeProposerApi({ getNetworkId: vi.fn(async () => 1) });

    const result = await loginWithWallet(api, 'proposer', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Your wallet is on Mainnet');
    expect(result.error).toContain('switch your wallet to Preprod');
    // No nonce is burned and nothing is signed on a doomed attempt.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.signData).not.toHaveBeenCalled();
  });

  it('proceeds when the wallet network matches', async () => {
    const fetchMock = makeFetch(FAKE_PAYLOAD, true);
    const api = makeProposerApi({ getNetworkId: vi.fn(async () => 0) });

    const result = await loginWithWallet(api, 'proposer', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(true);
  });

  it('proceeds when the wallet does not expose getNetworkId', async () => {
    const fetchMock = makeFetch(FAKE_PAYLOAD, true);
    const api = makeProposerApi(); // no getNetworkId

    const result = await loginWithWallet(api, 'proposer', 'preprod', { fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.ok).toBe(true);
  });
});
