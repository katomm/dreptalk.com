import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createKoiosClient.totals', () => {
  it('requests a specific epoch when given one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ epoch_no: 540, treasury: '111', reserves: '222' }]),
    );
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const row = await client.totals(540);

    expect(row).toEqual({ epochNo: 540, treasuryLovelace: '111', reservesLovelace: '222' });
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('/totals?');
    expect(url).toContain('_epoch_no=540');
  });

  it('keeps the newest-first single-row behavior without an epoch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ epoch_no: 541, treasury: '1', reserves: '2' }]),
    );
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await client.totals();

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('order=epoch_no.desc');
    expect(url).toContain('limit=1');
  });
});

describe('createKoiosClient.firstDrepPowerEpoch', () => {
  it('asks for the oldest summary row and returns its epoch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ epoch_no: 507, amount: '123', dreps: 10 }]),
    );
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    expect(await client.firstDrepPowerEpoch()).toBe(507);
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('/drep_epoch_summary?');
    expect(url).toContain('order=epoch_no.asc');
    expect(url).toContain('limit=1');
  });

  it('returns null on an empty result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    expect(await client.firstDrepPowerEpoch()).toBeNull();
  });
});
