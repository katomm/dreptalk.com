import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertVotes } from './drepVotes.js';
import { upsertActionRationale } from './actionRationale.js';
import { archiveSupersededVotes, getVoterVoteHistory, getActionVoteHistory } from './voteHistory.js';

async function seedVote(gaId: string, voterId: string, vote: string, metaUrl: string | null, blockTime: number | null) {
  await upsertVotes(env.DB, gaId, [{ voterRole: 'DRep', voterId, voterHex: null, vote, metaUrl, metaHash: metaUrl ? 'cc'.repeat(32) : null, blockTime }], 1000);
}

describe('archiveSupersededVotes', () => {
  it('archives the old row when the vote changed, with the old rationale body', async () => {
    const ga = `${'b'.repeat(64)}#0`;
    await seedVote(ga, 'drep1a', 'Abstain', 'ipfs://old', 100);
    await upsertActionRationale(env.DB, { gaId: ga, voterId: 'drep1a', bodyHtml: '<p>old why</p>', source: 'onchain', anchorUrl: 'ipfs://old', status: 'ok', createdAt: 100000, now: 100000 });

    const n = await archiveSupersededVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1a', voterHex: null, vote: 'No', metaUrl: 'ipfs://new', metaHash: 'dd'.repeat(32), blockTime: 200 },
    ], 5000);
    expect(n).toBe(1);

    const hist = await getVoterVoteHistory(env.DB, 'drep1a');
    const rows = hist.get(ga) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].vote).toBe('Abstain');
    expect(rows[0].block_time).toBe(100);
    expect(rows[0].body_html).toBe('<p>old why</p>');
  });

  it('archives when only the anchor changed and clears the stale rationale', async () => {
    const ga = `${'c'.repeat(64)}#0`;
    await seedVote(ga, 'drep1b', 'No', 'ipfs://v1', 100);
    await upsertActionRationale(env.DB, { gaId: ga, voterId: 'drep1b', bodyHtml: '<p>v1 why</p>', source: 'onchain', anchorUrl: 'ipfs://v1', status: 'ok', createdAt: 100000, now: 100000 });
    const n = await archiveSupersededVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1b', voterHex: null, vote: 'No', metaUrl: 'ipfs://v2', metaHash: 'ee'.repeat(32), blockTime: 200 },
    ], 5000);
    expect(n).toBe(1);
    // The stale rationale (anchored to v1) is gone; the cron re-fetches v2 via
    // its normal "no row yet" path. The old body survives on the history row.
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM action_rationale WHERE ga_id = ?`).bind(ga).first<{ n: number }>();
    expect(left?.n).toBe(0);
    const hist = await getVoterVoteHistory(env.DB, 'drep1b');
    expect(hist.get(ga)?.[0].body_html).toBe('<p>v1 why</p>');
  });

  it('keeps the rationale when the vote changed but the anchor stayed the same', async () => {
    const ga = `${'a'.repeat(63)}b#0`;
    await seedVote(ga, 'drep1keep', 'Yes', 'ipfs://same', 100);
    await upsertActionRationale(env.DB, { gaId: ga, voterId: 'drep1keep', bodyHtml: '<p>still valid</p>', source: 'onchain', anchorUrl: 'ipfs://same', status: 'ok', createdAt: 100000, now: 100000 });
    const n = await archiveSupersededVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1keep', voterHex: null, vote: 'No', metaUrl: 'ipfs://same', metaHash: 'cc'.repeat(32), blockTime: 200 },
    ], 5000);
    expect(n).toBe(1);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM action_rationale WHERE ga_id = ?`).bind(ga).first<{ n: number }>();
    expect(left?.n).toBe(1);
  });

  it('is a no-op when nothing changed, when the voter is new, or when block_time is not newer', async () => {
    const ga = `${'d'.repeat(64)}#0`;
    await seedVote(ga, 'drep1c', 'Yes', 'ipfs://same', 100);
    // Unchanged row, brand-new voter, and a stale (same block_time) incoming row.
    const n = await archiveSupersededVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1c', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://same', metaHash: null, blockTime: 100 },
      { voterRole: 'DRep', voterId: 'drep1new', voterHex: null, vote: 'No', metaUrl: null, metaHash: null, blockTime: 200 },
    ], 5000);
    expect(n).toBe(0);
  });

  it('skips rows with a local_status (pending self-cast votes)', async () => {
    const ga = `${'e'.repeat(64)}#0`;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, meta_hash, block_time, synced_at, local_status, tx_hash)
       VALUES (?, 'DRep', 'drep1p', NULL, 'Yes', 'https://dreptalk.com/r.json', NULL, NULL, 1000, 'pending', 'tx1')`,
    ).bind(ga).run();
    const n = await archiveSupersededVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1p', voterHex: null, vote: 'Yes', metaUrl: 'https://dreptalk.com/r.json', metaHash: null, blockTime: 300 },
    ], 5000);
    expect(n).toBe(0);
  });

  it('is idempotent (INSERT OR IGNORE on the history PK)', async () => {
    const ga = `${'f'.repeat(64)}#0`;
    await seedVote(ga, 'drep1d', 'Abstain', 'ipfs://old', 100);
    const incoming = [{ voterRole: 'DRep', voterId: 'drep1d', voterHex: null, vote: 'No', metaUrl: 'ipfs://new', metaHash: null, blockTime: 200 }];
    await archiveSupersededVotes(env.DB, ga, incoming, 5000);
    const n2 = await archiveSupersededVotes(env.DB, ga, incoming, 6000);
    expect(n2).toBe(0);
    const hist = await getVoterVoteHistory(env.DB, 'drep1d');
    expect(hist.get(ga)).toHaveLength(1);
  });

  it('deletes the orphaned rationale when the new vote has no anchor', async () => {
    const ga = `${'1'.repeat(63)}a#0`;
    await seedVote(ga, 'drep1e', 'Abstain', 'ipfs://old', 100);
    await upsertActionRationale(env.DB, { gaId: ga, voterId: 'drep1e', bodyHtml: '<p>old</p>', source: 'onchain', anchorUrl: 'ipfs://old', status: 'ok', createdAt: 100000, now: 100000 });
    await archiveSupersededVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1e', voterHex: null, vote: 'No', metaUrl: null, metaHash: null, blockTime: 200 },
    ], 5000);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM action_rationale WHERE ga_id = ?`).bind(ga).first<{ n: number }>();
    expect(left?.n).toBe(0);
    // The body survived in the history row.
    const hist = await getVoterVoteHistory(env.DB, 'drep1e');
    expect(hist.get(ga)?.[0].body_html).toBe('<p>old</p>');
  });

  it('getActionVoteHistory keys by voter and orders newest first', async () => {
    const ga = `${'2'.repeat(63)}b#0`;
    await seedVote(ga, 'drep1f', 'No', 'ipfs://v1', 100);
    await archiveSupersededVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1f', voterHex: null, vote: 'Abstain', metaUrl: 'ipfs://v2', metaHash: null, blockTime: 200 },
    ], 5000);
    await seedVote(ga, 'drep1f', 'Abstain', 'ipfs://v2', 200);
    await archiveSupersededVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1f', voterHex: null, vote: 'No', metaUrl: 'ipfs://v3', metaHash: null, blockTime: 300 },
    ], 6000);
    const map = await getActionVoteHistory(env.DB, ga);
    const rows = map.get('drep1f') ?? [];
    expect(rows.map((r) => r.block_time)).toEqual([200, 100]);
    expect(rows.map((r) => r.vote)).toEqual(['Abstain', 'No']);
  });
});
