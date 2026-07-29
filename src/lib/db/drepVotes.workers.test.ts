import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertVotes, getDrepVotingHistory, countDrepVotes, recordLocalVote, getViewerVote, markStalePendingVotesFailed, getActionSpoVoters, countActionSpoVoters, getVotesByGaId } from './drepVotes.js';
import { createTopic } from './forum.js';
import { upsertActionRationale } from './actionRationale.js';
import { upsertVoteRationalePost } from './voteRationalePost.js';

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
    // No block_time on these votes, so ordering falls back to the action's decided epoch.
    expect(history.map((h) => h.ga_id)).toEqual(['ga2', 'ga1']);
    expect(history[0].vote).toBe('No');
    expect(history[0].title).toBe('Action Two');

    expect(await countDrepVotes(env.DB, 'drepX')).toBe(2);
    expect(await countDrepVotes(env.DB, 'drepOther')).toBe(1);
  });

  it('orders by the vote time so a freshly changed vote on an open action leads', async () => {
    // A long-decided action the DRep voted on ages ago.
    await seedAction('gaDecided', 'Decided Action', 500);
    await upsertVotes(env.DB, 'gaDecided', [
      { voterRole: 'DRep', voterId: 'drepRev', voterHex: null, vote: 'No', blockTime: 1_000 },
    ], 1);
    // An action still open for voting (decided_epoch NULL) the DRep just re-voted on.
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
       VALUES ('gaOpen', 'InfoAction', 'Open Action', 'voting', NULL, NULL, 0, 0)`,
    ).run();
    await upsertVotes(env.DB, 'gaOpen', [
      { voterRole: 'DRep', voterId: 'drepRev', voterHex: null, vote: 'Yes', blockTime: 2_000 },
    ], 1);

    // The most recent vote must lead; an open action must not sink below decided ones.
    const history = await getDrepVotingHistory(env.DB, 'drepRev', { limit: 10 });
    expect(history.map((h) => h.ga_id)).toEqual(['gaOpen', 'gaDecided']);
  });

  it('upsertVotes persists the vote anchor hash', async () => {
    const gaId = `${'a'.repeat(64)}#0`;
    await upsertVotes(env.DB, gaId, [{
      voterRole: 'DRep', voterId: 'drep1power', voterHex: null, vote: 'yes',
      metaUrl: 'https://example.org/r.json', metaHash: 'ff'.repeat(32), blockTime: 1_700_000_000,
    }], 1_700_000_100);
    const row = await env.DB
      .prepare(`SELECT meta_hash FROM drep_votes WHERE ga_id = ? AND voter_id = ?`)
      .bind(gaId, 'drep1power').first<{ meta_hash: string }>();
    expect(row?.meta_hash).toBe('ff'.repeat(32));
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

it('lists only SPO voters for an action, newest first', async () => {
  await env.DB.prepare(
    `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, block_time, synced_at, local_status)
     VALUES ('gaX','SPO','pool1old','h1','Yes',100,1,'onchain'),
            ('gaX','SPO','pool1new','h2','No',200,1,'onchain'),
            ('gaX','DRep','drep1','h3','Yes',150,1,'onchain')`,
  ).run();
  const voters = await getActionSpoVoters(env.DB, 'gaX');
  expect(voters.map((v) => v.voter_id)).toEqual(['pool1new', 'pool1old']);
  expect(await countActionSpoVoters(env.DB, 'gaX')).toBe(2);
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

  it('hides a reconciled failed vote from public reads but keeps it for the viewer', async () => {
    await seedAction('gaFail', 'Fail Action', 600);
    await recordLocalVote(env.DB, { gaId: 'gaFail', drepId: 'drepFail', voterHex: null, vote: 'yes', metaUrl: null, txHash: 'txf', now: 1000 });
    // Optimistic (pending) vote is visible everywhere.
    expect((await getVotesByGaId(env.DB, 'gaFail')).has('drepFail')).toBe(true);
    expect(await countDrepVotes(env.DB, 'drepFail')).toBe(1);

    await markStalePendingVotesFailed(env.DB, 5000);

    // Gone from every public read once reconciled to failed...
    expect((await getVotesByGaId(env.DB, 'gaFail')).has('drepFail')).toBe(false);
    expect(await countDrepVotes(env.DB, 'drepFail')).toBe(0);
    expect((await getDrepVotingHistory(env.DB, 'drepFail')).length).toBe(0);
    // ...but the voter still sees their own failed attempt (drives the retry UI).
    expect((await getViewerVote(env.DB, 'gaFail', 'drepFail'))?.local_status).toBe('failed');
  });

  it('reaps the optimistic rationale and cross-post when a vote fails', async () => {
    const { topic } = await createTopic(env.DB, {
      categorySlug: 'governance', authorId: 'sys', title: 'Reap Action',
      bodyMd: 'x', bodyHtml: '<p>x</p>', source: 'governance', now: 1, rand: 'reap',
    });
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
       VALUES ('gaReap', 'InfoAction', 'Reap', 'enacted', 600, ?, 0, 0)`,
    ).bind(topic.id).run();
    await env.DB.prepare(`INSERT INTO users (id, drep_id, created_at, last_verified_at) VALUES ('userReap', 'drepReap', 0, 0)`).run();
    // Artifacts vote/record writes optimistically.
    await upsertActionRationale(env.DB, {
      gaId: 'gaReap', voterId: 'drepReap', bodyHtml: '<p>r</p>', source: 'dreptalk',
      anchorUrl: null, status: 'ok', createdAt: 1000, now: 1000,
    });
    await upsertVoteRationalePost(env.DB, { topicId: topic.id, authorId: 'userReap', vote: 'yes', bodyMd: 'r', bodyHtml: '<p>r</p>', now: 1000 });
    await recordLocalVote(env.DB, { gaId: 'gaReap', drepId: 'drepReap', voterHex: null, vote: 'yes', metaUrl: null, txHash: 'txr', now: 1000 });

    const before = (await env.DB.prepare('SELECT post_count FROM topics WHERE id = ?').bind(topic.id).first<{ post_count: number }>())?.post_count ?? 0;

    await markStalePendingVotesFailed(env.DB, 5000);

    const rat = await env.DB.prepare(`SELECT COUNT(*) AS n FROM action_rationale WHERE ga_id = 'gaReap' AND voter_id = 'drepReap'`).first<{ n: number }>();
    expect(rat?.n).toBe(0); // dreptalk rationale deleted
    const post = await env.DB.prepare(`SELECT deleted FROM posts WHERE topic_id = ? AND author_id = 'userReap' AND source = 'vote_rationale'`).bind(topic.id).first<{ deleted: number }>();
    expect(post?.deleted).toBe(1); // cross-post soft-deleted
    const after = (await env.DB.prepare('SELECT post_count FROM topics WHERE id = ?').bind(topic.id).first<{ post_count: number }>())?.post_count ?? 0;
    expect(after).toBe(before - 1); // topic count kept in step
  });
});

describe('upsertVotes voted_power', () => {
  it('does not null a stored voted_power when a later sync omits it', async () => {
    const ga = 'gaid_test_power';
    await upsertVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1', voterHex: null, vote: 'Yes', blockTime: 100, votedPower: 500 },
    ], 1);
    // A later sync of the same vote without a resolved power.
    await upsertVotes(env.DB, ga, [
      { voterRole: 'DRep', voterId: 'drep1', voterHex: null, vote: 'Yes', blockTime: 100, votedPower: null },
    ], 2);
    const row = await env.DB
      .prepare('SELECT voted_power FROM drep_votes WHERE ga_id = ? AND voter_id = ?')
      .bind(ga, 'drep1')
      .first<{ voted_power: number | null }>();
    expect(row?.voted_power).toBe(500);
  });

  it('updates voted_power when a new value is provided', async () => {
    const ga = 'gaid_test_power2';
    await upsertVotes(env.DB, ga, [{ voterRole: 'SPO', voterId: 'pool1', voterHex: null, vote: 'Yes', blockTime: 100, votedPower: 10 }], 1);
    await upsertVotes(env.DB, ga, [{ voterRole: 'SPO', voterId: 'pool1', voterHex: null, vote: 'Yes', blockTime: 100, votedPower: 20 }], 2);
    const row = await env.DB.prepare('SELECT voted_power FROM drep_votes WHERE ga_id = ? AND voter_id = ?').bind(ga, 'pool1').first<{ voted_power: number }>();
    expect(row?.voted_power).toBe(20);
  });
});
