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

// --- drepInfo ---

const DREP_ID = 'drep1ygfpzwl3u0r7e5dm6z7gz8afyw60rv5lnmtgcnw4nnrrzrdmytsk';

const drepInfoFixture: DrepInfo = {
  drep_id: DREP_ID,
  hex: 'abc123',
  has_script: false,
  registered: true,
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
    expect(result!.registered).toBe(true);
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
