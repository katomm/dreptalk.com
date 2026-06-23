import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertVotes, getDrepVotingHistory, countDrepVotes, recordLocalVote, getViewerVote, markStalePendingVotesFailed } from './drepVotes.js';

async function seedAction(id: string, title: string, decidedEpoch: number) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', ?, 'enacted', ?, NULL, 0, 0)`,
  ).bind(id, title, decidedEpoch).run();
}

describe('getDrepVotingHistory + countDrepVotes', () => {
  it('returns a DRep votes joined to action context, newest action first', async () => {
    await seedAction('ga1', 'Action One', 500);
    await seedAction('ga2', 'Action Two', 520);
    await upsertVotes(env.DB, 'ga1', [{ voterRole: 'DRep', voterId: 'drepX', voterHex: null, vote: 'Yes' }], 1);
    await upsertVotes(env.DB, 'ga2', [{ voterRole: 'DRep', voterId: 'drepX', voterHex: null, vote: 'No' }], 1);
    await upsertVotes(env.DB, 'ga1', [{ voterRole: 'DRep', voterId: 'drepOther', voterHex: null, vote: 'Yes' }], 1);

    const history = await getDrepVotingHistory(env.DB, 'drepX', { limit: 10 });
    expect(history.map((h) => h.ga_id)).toEqual(['ga2', 'ga1']); // newest decided first
    expect(history[0].vote).toBe('No');
    expect(history[0].title).toBe('Action Two');

    expect(await countDrepVotes(env.DB, 'drepX')).toBe(2);
    expect(await countDrepVotes(env.DB, 'drepOther')).toBe(1);
  });

  it('upsertVotes persists the rationale anchor (meta_url)', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
       VALUES ('m1', 'InfoAction', 'M1', 'enacted', 500, NULL, 0, 0)`,
    ).run();
    await upsertVotes(env.DB, 'm1', [
      { voterRole: 'DRep', voterId: 'drepM', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://rationale' },
    ], 1);
    const row = await env.DB.prepare('SELECT meta_url FROM drep_votes WHERE ga_id = ? AND voter_id = ?')
      .bind('m1', 'drepM').first<{ meta_url: string | null }>();
    expect(row?.meta_url).toBe('ipfs://rationale');
  });
});

describe('local vote record + reconcile', () => {
  const gaId = `${'b'.repeat(64)}#0`;
  const drepId = `drep1${'a'.repeat(50)}`;

  it('records a pending vote and reads it back', async () => {
    await recordLocalVote(env.DB, { gaId, drepId, voterHex: null, vote: 'yes', metaUrl: null, txHash: 'tx1', now: 1000 });
    const v = await getViewerVote(env.DB, gaId, drepId);
    expect(v?.vote).toBe('yes');
    expect(v?.local_status).toBe('pending');
    expect(v?.tx_hash).toBe('tx1');
  });

  it('authoritative upsert clears the pending marker', async () => {
    await recordLocalVote(env.DB, { gaId, drepId, voterHex: null, vote: 'yes', metaUrl: null, txHash: 'tx1', now: 1000 });
    await upsertVotes(env.DB, gaId, [{ voterRole: 'DRep', voterId: drepId, voterHex: null, vote: 'yes' }], 2000);
    const v = await getViewerVote(env.DB, gaId, drepId);
    expect(v?.local_status).toBeNull();
  });

  it('marks stale pending votes failed', async () => {
    await recordLocalVote(env.DB, { gaId, drepId, voterHex: null, vote: 'no', metaUrl: null, txHash: 'tx2', now: 1000 });
    const n = await markStalePendingVotesFailed(env.DB, 5000); // cutoff after synced_at=1000
    expect(n).toBe(1);
    const v = await getViewerVote(env.DB, gaId, drepId);
    expect(v?.local_status).toBe('failed');
  });
});
