import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('koios.drepUpdates', () => {
  it('parses update rows and sends pagination params, no _drep_id filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        { drep_id: 'drep1', action: 'registered', block_time: 1700000000 },
        { drep_id: 'drep1', action: 'updated', block_time: 1700500000 },
      ]),
    );
    const koios = createKoiosClient({ baseUrl: 'https://x/api/v1', fetchImpl });

    const rows = await koios.drepUpdates(1000, 0);

    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://x/api/v1/drep_updates?limit=1000&offset=0');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ drep_id: 'drep1', action: 'registered', block_time: 1700000000 });
  });
});
