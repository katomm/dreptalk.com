import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncGovernanceActions } from './sync.js';
import type { ProposalListRow } from '../koios/client.js';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';

const anchorDoc = {
  body: { title: 'Fund Community Tooling', abstract: 'A treasury withdrawal for tooling.', rationale: 'Rationale.' },
};
const anchorJson = JSON.stringify(anchorDoc);
const anchorHash = bytesToHex(blake2b256(new TextEncoder().encode(anchorJson)));
const fetchOk: typeof fetch = async () =>
  new Response(anchorJson, { headers: { 'content-type': 'application/json' } });

const proposals: ProposalListRow[] = [
  {
    proposal_id: 'gov_action1abc',
    proposal_tx_hash: 'aa'.repeat(32),
    proposal_index: 0,
    proposal_type: 'TreasuryWithdrawals',
    deposit: '100000000000',
    return_address: 'stake_test1xyz',
    proposed_epoch: 200,
    expiration: 230,
    meta_url: 'https://example.com/m.json',
    meta_hash: anchorHash,
  },
  {
    proposal_id: 'gov_action1def',
    proposal_tx_hash: 'bb'.repeat(32),
    proposal_index: 1,
    proposal_type: 'InfoAction',
    deposit: null,
    return_address: null,
    proposed_epoch: 201,
    expiration: null,
    meta_url: null,
    meta_hash: null,
  },
];

function fakeKoios(rows: ProposalListRow[]) {
  return { proposalList: async () => rows };
}

describe('syncGovernanceActions', () => {
  it('creates a thread + governance_actions row per new action, then is idempotent', async () => {
    let n = 0;
    const rand = () => `r${n++}`;

    const r1 = await syncGovernanceActions({
      koios: fakeKoios(proposals),
      db: env.DB,
      network: 'preprod',
      now: 1_700_000_000_000,
      rand,
      fetchImpl: fetchOk,
    });
    expect(r1).toMatchObject({ total: 2, created: 2, skipped: 0, failed: 0 });

    const topics = (
      await env.DB.prepare(
        "SELECT title, source, author_id FROM topics WHERE category_slug = 'governance-actions'",
      ).all<{ title: string; source: string; author_id: string }>()
    ).results;
    expect(topics.length).toBe(2);
    const anchored = topics.find((t) => t.title === 'Fund Community Tooling');
    expect(anchored).toBeTruthy();
    expect(anchored!.source).toBe('governance');
    expect(anchored!.author_id).toBe('gov-sync');
    // Action with no anchor gets a generated title from its type + tx hash.
    expect(topics.some((t) => t.title.startsWith('Info Action ('))).toBe(true);

    const gas = (
      await env.DB.prepare('SELECT id, type, anchor_status, topic_id FROM governance_actions').all<{
        id: string;
        type: string;
        anchor_status: string;
        topic_id: string;
      }>()
    ).results;
    expect(gas.length).toBe(2);
    const withAnchor = gas.find((g) => g.id === `${'aa'.repeat(32)}#0`);
    expect(withAnchor!.anchor_status).toBe('ok');
    expect(withAnchor!.topic_id).toBeTruthy();

    // Re-run: nothing new.
    const r2 = await syncGovernanceActions({
      koios: fakeKoios(proposals),
      db: env.DB,
      network: 'preprod',
      now: 1_700_000_100_000,
      rand,
      fetchImpl: fetchOk,
    });
    expect(r2).toMatchObject({ total: 2, created: 0, skipped: 2, failed: 0 });
  });
});
