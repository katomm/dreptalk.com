import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ROW = {
  epoch_no: 500,
  dvt_motion_no_confidence: 0.67,
  dvt_committee_normal: 0.67,
  dvt_committee_no_confidence: 0.6,
  dvt_update_to_constitution: 0.75,
  dvt_hard_fork_initiation: 0.6,
  dvt_p_p_network_group: 0.67,
  dvt_p_p_economic_group: 0.67,
  dvt_p_p_technical_group: 0.67,
  dvt_p_p_gov_group: 0.75,
  dvt_treasury_withdrawal: 0.67,
};

describe('createKoiosClient.epochParams', () => {
  it('parses dvt thresholds from the latest epoch params', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([ROW]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });
    const p = await client.epochParams();
    expect(p?.dvt_treasury_withdrawal).toBe(0.67);
    expect(p?.dvt_update_to_constitution).toBe(0.75);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.koios.rest/api/v1/epoch_params?order=epoch_no.desc&limit=1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns null when Koios returns no rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });
    expect(await client.epochParams()).toBeNull();
  });
});
