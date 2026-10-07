import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchStakeRegistrations, rewardAddressToStakeBech32 } from './stakeAccount.js';
import { decodeBech32 } from '../crypto/bech32.js';
import { bytesToHex } from '../crypto/hex.js';

// A real preprod stake address; its raw bytes are the 29-byte reward address a
// CIP-30 wallet returns from getRewardAddresses() (in hex).
const FIXTURE_STAKE_ADDR = 'stake_test1uqpqhw7q2jcutnwteqnvdgqkjulnaa5ym8wh70kcu3yvkugckkcgj';

describe('rewardAddressToStakeBech32', () => {
  it('re-encodes a preprod reward address hex back to its stake_test bech32 form', () => {
    const hex = bytesToHex(decodeBech32(FIXTURE_STAKE_ADDR).data);
    expect(rewardAddressToStakeBech32(hex, 'preprod')).toBe(FIXTURE_STAKE_ADDR);
  });

  it('uses the bare stake prefix on mainnet', () => {
    // Mainnet stake-key reward address: header 0xe1 + 28-byte key credential.
    const hex = `e1${'ab'.repeat(28)}`;
    expect(rewardAddressToStakeBech32(hex, 'mainnet').startsWith('stake1')).toBe(true);
  });

  it('rejects an address that is not 29 bytes', () => {
    expect(() => rewardAddressToStakeBech32('e1ff', 'mainnet')).toThrow();
  });
});

describe('fetchStakeRegistrations', () => {
  afterEach(() => vi.unstubAllGlobals());

  const A = 'stake_test1aaa';
  const B = 'stake_test1bbb';
  const C = 'stake_test1ccc';

  it('asks account_info once for every distinct address and maps each row by its address', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify([
          { stake_address: B, status: 'not registered' },
          { stake_address: A, status: 'registered' },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchStakeRegistrations({ stakeAddresses: [A, B, A, C], origin: 'https://x' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x/api/koios/account_info');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ _stake_addresses: [A, B, C] });
    // C has no row at all: a never-seen stake address is not registered.
    expect(result).toEqual(
      new Map([
        [A, true],
        [B, false],
        [C, false],
      ]),
    );
  });

  it('makes no request for an empty list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchStakeRegistrations({ stakeAddresses: [], origin: 'https://x' })).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a failed request, so the caller can offer a retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    await expect(fetchStakeRegistrations({ stakeAddresses: [A], origin: 'https://x' })).rejects.toThrow(
      /account_info request failed: 502/,
    );
  });
});
