import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listDecidedVoteChangeRows, countVoteChangeCoverage } from './voteChangeStats.js';
import { upsertVotes } from './drepVotes.js';

async function seedTopic(id: string, slug: string, title: string) {
  await env.DB.prepare(
    `INSERT INTO topics (id, category_slug, author_id, source, title, slug, deleted, last_post_at, created_at)
     VALUES (?, 'governance', 'gov-sync', 'governance', ?, ?, 0, 0, 0)`,
  ).bind(id, title, slug).run();
}

async function seedAction(
  id: string,
  opts: { decided?: number | null; swept?: boolean; title?: string; topicId?: string | null } = {},
) {
  const decidedEpoch = opts.decided === undefined ? 600 : opts.decided;
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, vote_history_swept_at, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', ?, 'enacted', ?, ?, ?, 0, 0)`,
  ).bind(id, opts.title ?? id, decidedEpoch, opts.swept === false ? null : 1, opts.topicId ?? null).run();
}

async function seedHistory(gaId: string, voterId: string, votes: { vote: string; t: number }[], role = 'DRep') {
  for (const v of votes) {
    await env.DB.prepare(
      `INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, block_time, superseded_at) VALUES (?, ?, ?, ?, ?, 1)`,
    ).bind(gaId, voterId, role, v.vote, v.t).run();
  }
}

describe('listDecidedVoteChangeRows', () => {
  it('returns first vs current per DRep voter on decided swept actions only', async () => {
    await seedTopic('topic_vc1', 'slug-vc1', 'Action VC1');
    await seedAction('ga_vc1#0', { title: 'Action VC1', topicId: 'topic_vc1' });
    await seedAction('ga_vc2#0', { swept: false });
    await seedAction('ga_vc3#0', { decided: null });
    // Voter changed Yes -> No -> Abstain: first Yes, current Abstain.
    await seedHistory('ga_vc1#0', 'drep_x', [{ vote: 'Yes', t: 10 }, { vote: 'No', t: 20 }]);
    await upsertVotes(env.DB, 'ga_vc1#0', [{ voterRole: 'DRep', voterId: 'drep_x', voterHex: null, vote: 'Abstain' }], 1);
    // SPO history must not appear.
    await seedHistory('ga_vc1#0', 'pool_y', [{ vote: 'Yes', t: 10 }], 'SPO');
    await upsertVotes(env.DB, 'ga_vc1#0', [{ voterRole: 'SPO', voterId: 'pool_y', voterHex: null, vote: 'No' }], 1);
    // History on the unswept and undecided actions must not appear.
    await seedHistory('ga_vc2#0', 'drep_x', [{ vote: 'Yes', t: 10 }]);
    await upsertVotes(env.DB, 'ga_vc2#0', [{ voterRole: 'DRep', voterId: 'drep_x', voterHex: null, vote: 'No' }], 1);
    await seedHistory('ga_vc3#0', 'drep_x', [{ vote: 'Yes', t: 10 }]);
    await upsertVotes(env.DB, 'ga_vc3#0', [{ voterRole: 'DRep', voterId: 'drep_x', voterHex: null, vote: 'No' }], 1);
    // Orphan history (no current vote) must not appear in rows.
    await seedHistory('ga_vc1#0', 'drep_gone', [{ vote: 'Yes', t: 10 }]);

    const rows = await listDecidedVoteChangeRows(env.DB);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gaId: 'ga_vc1#0',
      title: 'Action VC1',
      firstVote: 'Yes',
      currentVote: 'Abstain',
      decidedEpoch: 600,
    });
    expect(rows[0].topicSlug).toBe('slug-vc1');
  });
});

describe('countVoteChangeCoverage', () => {
  it('counts swept and unswept decided actions and orphan pairs', async () => {
    await seedAction('ga_cov1#0', {});
    await seedAction('ga_cov2#0', { swept: false });
    await seedAction('ga_cov3#0', { decided: null });
    await seedHistory('ga_cov1#0', 'drep_gone', [{ vote: 'Yes', t: 10 }, { vote: 'No', t: 20 }]);
    const c = await countVoteChangeCoverage(env.DB);
    expect(c.decidedSwept).toBe(1);
    expect(c.decidedUnswept).toBe(1);
    // Two history rows for the same missing voter are ONE orphan pair.
    expect(c.orphanPairs).toBe(1);
  });
});
