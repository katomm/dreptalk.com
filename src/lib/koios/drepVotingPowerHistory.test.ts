import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createKoiosClient.drepVotingPowerHistory', () => {
  it('requests one epoch page and parses the rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        { drep_id: 'drep1aaa', epoch_no: 540, amount: '14231445553' },
        { drep_id: 'drep1bbb', epoch_no: 540, amount: '900000000' },
      ]),
    );
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const rows = await client.drepVotingPowerHistory(540);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ drep_id: 'drep1aaa', epoch_no: 540, amount: '14231445553' });
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('/drep_voting_power_history?');
    expect(url).toContain('_epoch_no=540');
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'GET' }));
  });

  it('passes limit and offset for pagination', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    await client.drepVotingPowerHistory(540, 1000, 2000);

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('limit=1000');
    expect(url).toContain('offset=2000');
  });

  it('tolerates a null amount', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ drep_id: 'drep1ccc', epoch_no: 539, amount: null }]),
    );
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });

    const rows = await client.drepVotingPowerHistory(539);

    expect(rows[0].amount).toBeNull();
  });
});
