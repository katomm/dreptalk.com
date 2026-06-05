import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client';

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
});
