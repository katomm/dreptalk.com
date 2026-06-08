import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client';
import type { DrepListRow, DrepInfoRow } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// --- drepList ---

const DREP_ID = 'drep1ygfpzwl3u0r7e5dm6z7gz8afyw60rv5lnmtgcnw4nnrrzrdmytsk';

const drepListRowFixture: DrepListRow = {
  drep_id: DREP_ID,
  hex: 'abc123deadbeef',
  has_script: false,
  registered: true,
};

describe('createKoiosClient.drepList', () => {
  it('parses a sample row and GETs the right URL with default limit/offset', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([drepListRowFixture]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    const result = await client.drepList();

    expect(result).toHaveLength(1);
    expect(result[0].drep_id).toBe(DREP_ID);
    expect(result[0].hex).toBe('abc123deadbeef');
    expect(result[0].has_script).toBe(false);
    expect(result[0].registered).toBe(true);

    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://api.koios.rest/api/v1/drep_list?limit=1000&offset=0');
    expect(fetchImpl).toHaveBeenCalledWith(calledUrl, expect.objectContaining({ method: 'GET' }));
  });

  it('uses provided limit and offset in the URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    await client.drepList(500, 1000);

    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://api.koios.rest/api/v1/drep_list?limit=500&offset=1000');
  });

  it('returns an empty array when the response is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    const result = await client.drepList();
    expect(result).toEqual([]);
  });

  it('sends the bearer token when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([drepListRowFixture]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      token: 'test-token',
      fetchImpl,
    });

    await client.drepList();

    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
  });

  it('tolerates extra fields via passthrough', async () => {
    const withExtra = { ...drepListRowFixture, unknown_future_field: 'some value' };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([withExtra]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    const result = await client.drepList();
    expect(result[0]).toMatchObject(drepListRowFixture);
  });

  it('throws on non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    await expect(client.drepList()).rejects.toThrow(/koios request failed: 503/i);
  });
});

// --- drepInfoBatch ---

const drepInfoRowFixture: DrepInfoRow = {
  drep_id: DREP_ID,
  hex: 'abc123deadbeef',
  has_script: false,
  drep_status: 'registered',
  deposit: '500000000',
  active: true,
  expires_epoch_no: 600,
  amount: '1500000000',
  meta_url: 'https://example.com/drep-metadata.json',
  meta_hash: 'cafebabe1234',
};

describe('createKoiosClient.drepInfoBatch', () => {
  it('POSTs _drep_ids to /drep_info and parses a full row', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([drepInfoRowFixture]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    const result = await client.drepInfoBatch([DREP_ID]);

    expect(result).toHaveLength(1);
    expect(result[0].drep_id).toBe(DREP_ID);
    expect(result[0].drep_status).toBe('registered');
    expect(result[0].active).toBe(true);
    expect(result[0].amount).toBe('1500000000');
    expect(result[0].meta_url).toBe('https://example.com/drep-metadata.json');
    expect(result[0].meta_hash).toBe('cafebabe1234');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.koios.rest/api/v1/drep_info',
      expect.objectContaining({ method: 'POST' }),
    );
    const callInit = fetchImpl.mock.calls[0][1] as RequestInit & {
      body: string;
      headers: Record<string, string>;
    };
    expect(JSON.parse(callInit.body)).toEqual({ _drep_ids: [DREP_ID] });
    expect(callInit.headers['content-type']).toBe('application/json');
  });

  it('parses a row where all nullable fields are null', async () => {
    const sparse: DrepInfoRow = {
      drep_id: DREP_ID,
      hex: 'abc123',
      has_script: false,
      drep_status: 'expired',
      deposit: null,
      active: false,
      expires_epoch_no: null,
      amount: null,
      meta_url: null,
      meta_hash: null,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([sparse]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    const result = await client.drepInfoBatch([DREP_ID]);

    expect(result).toHaveLength(1);
    expect(result[0].deposit).toBeNull();
    expect(result[0].expires_epoch_no).toBeNull();
    expect(result[0].amount).toBeNull();
    expect(result[0].meta_url).toBeNull();
    expect(result[0].meta_hash).toBeNull();
  });

  it('returns [] without calling fetch for an empty id list', async () => {
    const fetchImpl = vi.fn();
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    const result = await client.drepInfoBatch([]);

    expect(result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the bearer token when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([drepInfoRowFixture]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      token: 'my-secret',
      fetchImpl,
    });

    await client.drepInfoBatch([DREP_ID]);

    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-secret');
  });

  it('tolerates extra fields via passthrough', async () => {
    const withExtra = { ...drepInfoRowFixture, future_field: 'ignored' };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([withExtra]));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    const result = await client.drepInfoBatch([DREP_ID]);
    expect(result[0]).toMatchObject(drepInfoRowFixture);
  });

  it('throws on non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    await expect(client.drepInfoBatch([DREP_ID])).rejects.toThrow(/koios request failed: 500/i);
  });

  it('splits the batch and retries when Koios answers 413 (payload too large)', async () => {
    const ids = ['drep1a', 'drep1b', 'drep1c', 'drep1d', 'drep1e'];
    // Simulate a Koios body cap: any POST with more than one id is rejected 413.
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body as string) as { _drep_ids: string[] };
      if (body._drep_ids.length > 1) return jsonResponse({}, 413);
      return jsonResponse([{ ...drepInfoRowFixture, drep_id: body._drep_ids[0] }]);
    });
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const result = await client.drepInfoBatch(ids);

    // Every id is still resolved, despite the cap forcing a split down to singles.
    expect(result.map((r) => r.drep_id).sort()).toEqual([...ids].sort());
  });

  it('does not split or retry on a non-413 error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await expect(client.drepInfoBatch(['drep1a', 'drep1b'])).rejects.toThrow(/koios request failed: 500/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('KoiosHttpError', () => {
  it('carries the HTTP status from a failed request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await expect(client.drepList()).rejects.toMatchObject({ status: 503 });
  });
});
