import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client';
import type { DrepInfo, AccountInfo } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createKoiosClient.tip', () => {
  it('parses a valid tip response and calls the right URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ epoch_no: 500, block_no: 1234567, abs_slot: 99 }]),
    );
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    const tip = await client.tip();

    expect(tip.epoch_no).toBe(500);
    expect(tip.block_no).toBe(1234567);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.koios.rest/api/v1/tip',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sends the bearer token when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ epoch_no: 1, block_no: 1, abs_slot: 1 }]),
    );
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      token: 'secret',
      fetchImpl,
    });

    await client.tip();

    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
  });

  it('throws on a non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    await expect(client.tip()).rejects.toThrow(/koios request failed: 503/i);
  });

  it('throws when the response shape is invalid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ wrong: true }]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    await expect(client.tip()).rejects.toThrow();
  });

  it('throws when the response is an empty array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    await expect(client.tip()).rejects.toThrow();
  });
});

describe('createKoiosClient retry', () => {
  it('retries a transient 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse([{ epoch_no: 7, block_no: 8, abs_slot: 9 }]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1', fetchImpl, retries: 2, retryDelayMs: 0,
    });

    const tip = await client.tip();

    expect(tip.epoch_no).toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a network/timeout error then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(jsonResponse([{ epoch_no: 1, block_no: 1, abs_slot: 1 }]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1', fetchImpl, retries: 1, retryDelayMs: 0,
    });

    const tip = await client.tip();

    expect(tip.epoch_no).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 4xx client error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 400));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1', fetchImpl, retries: 3, retryDelayMs: 0,
    });

    await expect(client.tip()).rejects.toThrow(/koios request failed: 400/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries on a persistent 504', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 504));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1', fetchImpl, retries: 2, retryDelayMs: 0,
    });

    await expect(client.tip()).rejects.toThrow(/koios request failed: 504/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('does not retry by default (retries: 0)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await expect(client.tip()).rejects.toThrow(/koios request failed: 503/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// --- drepInfo ---

const DREP_ID = 'drep1ygfpzwl3u0r7e5dm6z7gz8afyw60rv5lnmtgcnw4nnrrzrdmytsk';

const drepInfoFixture: DrepInfo = {
  drep_id: DREP_ID,
  hex: 'abc123',
  has_script: false,
  drep_status: 'registered',
  deposit: '500000000',
  active: true,
  expires_epoch_no: 600,
};

describe('createKoiosClient.drepInfo', () => {
  it('parses a registered active drep and POSTs to the right URL with correct body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([drepInfoFixture]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    const result = await client.drepInfo(DREP_ID);

    expect(result).not.toBeNull();
    expect(result!.drep_id).toBe(DREP_ID);
    expect(result!.active).toBe(true);
    expect(result!.drep_status).toBe('registered');
    expect(result!.has_script).toBe(false);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.koios.rest/api/v1/drep_info',
      expect.objectContaining({ method: 'POST' }),
    );
    const callInit = fetchImpl.mock.calls[0][1] as RequestInit & { body: string; headers: Record<string, string> };
    expect(JSON.parse(callInit.body)).toEqual({ _drep_ids: [DREP_ID] });
    expect(callInit.headers['content-type']).toBe('application/json');
  });

  it('returns null when the array is empty (drep not found)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const result = await client.drepInfo(DREP_ID);

    expect(result).toBeNull();
  });

  it('tolerates nullable optional fields (deposit null, expires_epoch_no null)', async () => {
    const sparse = { ...drepInfoFixture, deposit: null, expires_epoch_no: null };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([sparse]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const result = await client.drepInfo(DREP_ID);

    expect(result).not.toBeNull();
    expect(result!.deposit).toBeNull();
    expect(result!.expires_epoch_no).toBeNull();
  });

  it('throws on non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await expect(client.drepInfo(DREP_ID)).rejects.toThrow(/koios request failed: 500/i);
  });
});

// --- accountInfo ---

const STAKE_ADDR = 'stake1uxpdrerp9wrxunfh6ukyv5267j70fzxgw0fr3z8zeac5vyqhf9jhy';

const accountInfoFixture: AccountInfo = {
  stake_address: STAKE_ADDR,
  status: 'registered',
  delegated_pool: 'pool1abc',
  delegated_drep: DREP_ID,
  total_balance: '10000000',
};

describe('createKoiosClient.accountInfo', () => {
  it('parses account info and POSTs to the right URL with correct body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([accountInfoFixture]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const result = await client.accountInfo(STAKE_ADDR);

    expect(result).not.toBeNull();
    expect(result!.stake_address).toBe(STAKE_ADDR);
    expect(result!.status).toBe('registered');
    expect(result!.delegated_drep).toBe(DREP_ID);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.koios.rest/api/v1/account_info',
      expect.objectContaining({ method: 'POST' }),
    );
    const callInit = fetchImpl.mock.calls[0][1] as RequestInit & { body: string; headers: Record<string, string> };
    expect(JSON.parse(callInit.body)).toEqual({ _stake_addresses: [STAKE_ADDR] });
    expect(callInit.headers['content-type']).toBe('application/json');
  });

  it('returns null when account not found (empty array)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const result = await client.accountInfo(STAKE_ADDR);

    expect(result).toBeNull();
  });

  it('tolerates all nullable fields being null', async () => {
    const sparse = {
      stake_address: STAKE_ADDR,
      status: 'not registered',
      delegated_pool: null,
      delegated_drep: null,
      total_balance: null,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([sparse]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const result = await client.accountInfo(STAKE_ADDR);

    expect(result).not.toBeNull();
    expect(result!.delegated_drep).toBeNull();
  });

  it('throws on non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await expect(client.accountInfo(STAKE_ADDR)).rejects.toThrow(/koios request failed: 401/i);
  });
});

// --- proposalsByReturnAddress ---

describe('createKoiosClient.proposalsByReturnAddress', () => {
  it('returns an array of proposals and GETs the right URL', async () => {
    const proposals = [
      { proposal_id: 'gov_action1abc', return_address: STAKE_ADDR, proposal_type: 'InfoAction', extra_field: 'ignored' },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(proposals));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const result = await client.proposalsByReturnAddress(STAKE_ADDR);

    expect(result).toHaveLength(1);
    expect(result[0].proposal_id).toBe('gov_action1abc');
    expect(result[0].return_address).toBe(STAKE_ADDR);
    expect(result[0].proposal_type).toBe('InfoAction');

    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      `https://api.koios.rest/api/v1/proposal_list?return_address=eq.${encodeURIComponent(STAKE_ADDR)}`,
    );
    expect(fetchImpl).toHaveBeenCalledWith(calledUrl, expect.objectContaining({ method: 'GET' }));
  });

  it('returns an empty array when no proposals are found', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const result = await client.proposalsByReturnAddress(STAKE_ADDR);

    expect(result).toEqual([]);
  });

  it('throws on non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await expect(client.proposalsByReturnAddress(STAKE_ADDR)).rejects.toThrow(/koios request failed: 503/i);
  });
});

// --- poolCalidusKey ---

const CALIDUS_PUBKEY_HEX = '200bff1edb79e633786f7f1bc2989d61db7cb1211e6a55b6efc5b6203ff711dd';
const calidusRowFixture = {
  pool_id_bech32: 'pool10dtwvn64akqjdtn9d4pd2mnhpxfgp76hvsfkgmfwugrsxef3y2p',
  calidus_pub_key: CALIDUS_PUBKEY_HEX,
  calidus_id_bech32: 'calidus15xdvep33kxuvep5h6h0vqzarsc5f4khre4lr7ptv8qefs2s0vtnj6',
  registered: true,
  pool_status: 'registered',
};

describe('createKoiosClient.poolCalidusKey', () => {
  it('GETs /pool_calidus_keys filtered by calidus_pub_key and returns the row', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([calidusRowFixture]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const result = await client.poolCalidusKey(CALIDUS_PUBKEY_HEX);

    expect(result).not.toBeNull();
    expect(result!.pool_id_bech32).toBe(calidusRowFixture.pool_id_bech32);
    expect(result!.calidus_pub_key).toBe(CALIDUS_PUBKEY_HEX);
    expect(result!.registered).toBe(true);
    expect(result!.pool_status).toBe('registered');

    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/pool_calidus_keys?');
    expect(calledUrl).toContain(`calidus_pub_key=eq.${CALIDUS_PUBKEY_HEX}`);
    expect(fetchImpl).toHaveBeenCalledWith(calledUrl, expect.objectContaining({ method: 'GET' }));
  });

  it('returns null when no calidus key matches (empty array)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    expect(await client.poolCalidusKey(CALIDUS_PUBKEY_HEX)).toBeNull();
  });

  it('throws on non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 502));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await expect(client.poolCalidusKey(CALIDUS_PUBKEY_HEX)).rejects.toThrow(/koios request failed: 502/i);
  });
});

// --- committeeInfo ---

const committeeResponseFixture = [
  {
    proposal_id: null,
    quorum_numerator: 2,
    quorum_denominator: 3,
    members: [
      {
        status: 'authorized',
        cc_hot_id: 'cc_hot1qwlykh9rzq3s3z2qaw2j6qdaxed0psedz05eu0qxj20038qc7zdu7',
        cc_cold_id: 'cc_cold1zvcxrfwegfn9ls72cmfchty3cnczwtztc2e48eyxxwnrw3cwfypz8',
        cc_hot_hex: 'be4b5ca31023088940eb952d01bd365af0c32d13e99e3c06929ef89c',
        cc_cold_hex: '3061a5d942665fc3cac6d38bac91c4f0272c4bc2b353e48633a63747',
        expiration_epoch: 242,
        cc_hot_has_script: true,
        cc_cold_has_script: true,
      },
      {
        status: 'not_authorized',
        cc_hot_id: null,
        cc_cold_id: 'cc_cold1zvh55mr0px8zpmjtl4dnn9pvzezht7xwkdyww4xlt58vqnc6qdgps',
        cc_hot_hex: null,
        cc_cold_hex: '2f4a6c6f098e20ee4bfd5b39942c164575f8ceb348e754df5d0ec04f',
        expiration_epoch: 229,
        cc_hot_has_script: null,
        cc_cold_has_script: true,
      },
    ],
  },
];

describe('createKoiosClient.committeeInfo', () => {
  it('GETs /committee_info and returns the members array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(committeeResponseFixture));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const members = await client.committeeInfo();

    expect(members).toHaveLength(2);
    expect(members[0].status).toBe('authorized');
    expect(members[0].cc_hot_hex).toBe('be4b5ca31023088940eb952d01bd365af0c32d13e99e3c06929ef89c');
    expect(members[0].cc_hot_has_script).toBe(true);
    expect(members[1].cc_hot_id).toBeNull();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.koios.rest/api/v1/committee_info',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns an empty array when there is no committee row', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    expect(await client.committeeInfo()).toEqual([]);
  });

  it('throws on non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await expect(client.committeeInfo()).rejects.toThrow(/koios request failed: 500/i);
  });
});
