import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PID = 'gov_action1xvzf2tqsvxc3k6pywjpmm8fnz79sngawttn39qs4nxddg6ayz45qq5n7n0j';

// Trimmed real preprod /proposal_voting_summary row.
const summaryFixture = {
  proposal_type: 'TreasuryWithdrawals',
  epoch_no: 293,
  drep_yes_votes_cast: 1,
  drep_no_votes_cast: 1,
  drep_abstain_votes_cast: 1,
  drep_yes_pct: 0.01,
  drep_no_pct: 99.99,
  drep_active_yes_vote_power: '29497454745',
  drep_active_no_vote_power: '3536695673892',
  drep_active_abstain_vote_power: '0',
  pool_yes_votes_cast: 0,
  pool_no_votes_cast: 0,
  pool_abstain_votes_cast: 0,
  pool_yes_pct: 0,
  pool_no_pct: 0,
  committee_yes_votes_cast: 0,
  committee_no_votes_cast: 0,
  committee_abstain_votes_cast: 0,
  committee_yes_pct: 0,
  committee_no_pct: 100,
};

describe('createKoiosClient.proposalVotingSummary', () => {
  it('GETs _proposal_id and parses the power-weighted pct fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([summaryFixture]));
    const client = createKoiosClient({ baseUrl: 'https://preprod.koios.rest/api/v1', fetchImpl });

    const r = await client.proposalVotingSummary(PID);
    expect(r).not.toBeNull();
    expect(r!.drep_no_pct).toBeCloseTo(99.99);
    expect(r!.drep_yes_votes_cast).toBe(1);
    expect(r!.committee_no_pct).toBe(100);
    expect(r!.drep_active_yes_vote_power).toBe('29497454745');
    expect(r!.drep_active_no_vote_power).toBe('3536695673892');
    expect(r!.drep_active_abstain_vote_power).toBe('0');

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('/proposal_voting_summary?_proposal_id=');
    expect(url).toContain(encodeURIComponent(PID));
  });

  it('returns null when Koios returns an empty array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://preprod.koios.rest/api/v1', fetchImpl });
    expect(await client.proposalVotingSummary(PID)).toBeNull();
  });

  it('sends the bearer token when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([summaryFixture]));
    const client = createKoiosClient({ baseUrl: 'https://preprod.koios.rest/api/v1', token: 'k', fetchImpl });
    await client.proposalVotingSummary(PID);
    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k');
  });
});

describe('createKoiosClient.proposalVotes', () => {
  const voteFixture = {
    block_time: 1779908217,
    voter_role: 'DRep',
    voter_id: 'drep1y2386pkjxd4n48d3hkx0ppm573dwunhze83mdwaaay90w5c2hplp3',
    voter_hex: 'a27d06d2336b3a9db1bd8cf08774f45aee4ee2c9e3b6bbbde90af753',
    vote: 'Yes',
  };

  it('GETs _proposal_id with pagination and parses vote rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([voteFixture]));
    const client = createKoiosClient({ baseUrl: 'https://preprod.koios.rest/api/v1', fetchImpl });

    const rows = await client.proposalVotes(PID, 500, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].voter_role).toBe('DRep');
    expect(rows[0].vote).toBe('Yes');
    expect(rows[0].voter_id).toContain('drep1');

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('/proposal_votes?_proposal_id=');
    expect(url).toContain('limit=500');
  });

  it('tolerates a null voter_hex', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ ...voteFixture, voter_hex: null }]));
    const client = createKoiosClient({ baseUrl: 'https://preprod.koios.rest/api/v1', fetchImpl });
    const rows = await client.proposalVotes(PID);
    expect(rows[0].voter_hex).toBeNull();
  });

  it('throws on a non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = createKoiosClient({ baseUrl: 'https://preprod.koios.rest/api/v1', fetchImpl });
    await expect(client.proposalVotes(PID)).rejects.toThrow(/koios request failed: 500/i);
  });

  it('tolerates raw control characters in a string value (a stray newline in meta_url)', async () => {
    // A real Koios response carried a vote whose meta_url had a trailing newline.
    // Strict JSON parsing rejects raw control characters, which used to fail the
    // whole response; the client strips them before parsing. The body below is a
    // raw string (not JSON.stringify) so the newline stays unescaped, as Koios sent it.
    const body = '[{"voter_role":"DRep","voter_id":"drep1xyz","vote":"Yes","meta_url":"https://ipfs.io/ipfs/Qm123\n"}]';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createKoiosClient({ baseUrl: 'https://preprod.koios.rest/api/v1', fetchImpl });

    const rows = await client.proposalVotes(PID);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta_url).toBe('https://ipfs.io/ipfs/Qm123');
  });
});
