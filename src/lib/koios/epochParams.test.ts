import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// --- epochParams ---

describe('createKoiosClient.epochParams', () => {
  it('parses a one-row response and returns the dvt_*/pvt_* fields', async () => {
    const fixture = [
      {
        epoch_no: 540,
        dvt_treasury_withdrawal: 0.67,
        pvtpp_security_group: 0.51,
        committee_min_size: 7,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fixture));
    const client = createKoiosClient({
      baseUrl: 'https://api.koios.rest/api/v1',
      fetchImpl,
    });

    const result = await client.epochParams();

    expect(result).not.toBeNull();
    expect(result!.epoch_no).toBe(540);
    expect(result!.dvt_treasury_withdrawal).toBe(0.67);
    expect(result!.pvtpp_security_group).toBe(0.51);
    expect(result!.committee_min_size).toBe(7);

    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://api.koios.rest/api/v1/epoch_params?limit=1');
    expect(fetchImpl).toHaveBeenCalledWith(calledUrl, expect.objectContaining({ method: 'GET' }));
  });

  it('returns null when the array is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    expect(await client.epochParams()).toBeNull();
  });

  it('throws on non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await expect(client.epochParams()).rejects.toThrow(/koios request failed: 503/i);
  });
});

// --- committeeQuorum ---

describe('createKoiosClient.committeeQuorum', () => {
  it('returns numerator/denominator as a fraction', async () => {
    const fixture = [{ members: [], quorum_numerator: 2, quorum_denominator: 3 }];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fixture));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const result = await client.committeeQuorum();

    expect(result).toBeCloseTo(2 / 3);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.koios.rest/api/v1/committee_info',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns null when quorum fields are absent', async () => {
    const fixture = [{ members: [] }];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fixture));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    expect(await client.committeeQuorum()).toBeNull();
  });

  it('returns null when there is no committee row', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    expect(await client.committeeQuorum()).toBeNull();
  });

  it('throws on non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await expect(client.committeeQuorum()).rejects.toThrow(/koios request failed: 500/i);
  });
});
