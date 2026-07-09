import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listRecentlyActiveAuthorIds } from './recentlyActive.js';

const NOW = 1_700_000_000_000;

async function seedUser(
  id: string,
  opts: { isDrep?: boolean; isSpo?: boolean; drepId?: string; poolId?: string } = {},
) {
  await env.DB.prepare(
    `INSERT INTO users (id, drep_id, pool_id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 'member', 'active', ?, ?)`,
  )
    .bind(id, opts.drepId ?? null, opts.poolId ?? null, opts.isDrep ? 1 : 0, opts.isSpo ? 1 : 0, NOW, NOW)
    .run();
}

async function seedTopic(id = 't1', opts: { deleted?: boolean } = {}) {
  await env.DB.prepare(
    `INSERT INTO topics (id, category_slug, author_id, source, title, slug, deleted, last_post_at, created_at)
     VALUES (?, 'general', 'gov-sync', 'user', 'T', ?, ?, ?, ?)`,
  ).bind(id, `t-${id}`, opts.deleted ? 1 : 0, NOW, NOW).run();
}

async function seedPost(
  id: string,
  authorId: string,
  createdAt: number,
  opts: { deleted?: boolean; hidden?: boolean; topicId?: string } = {},
) {
  await env.DB.prepare(
    `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, deleted, hidden, created_at)
     VALUES (?, ?, ?, 'b', '<p>b</p>', ?, ?, ?)`,
  ).bind(id, opts.topicId ?? 't1', authorId, opts.deleted ? 1 : 0, opts.hidden ? 1 : 0, createdAt).run();
}

describe('listRecentlyActiveAuthorIds', () => {
  it('returns only DReps/SPOs, newest activity first, excluding members and the system author', async () => {
    await seedTopic();

    // A DRep whose most recent post is at NOW+300.
    await seedUser('drepA', { isDrep: true, drepId: 'drepA' });
    await seedPost('p1', 'drepA', NOW + 100);
    await seedPost('p2', 'drepA', NOW + 300);

    // An SPO whose most recent post is at NOW+200.
    await seedUser('poolB', { isSpo: true, poolId: 'poolB' });
    await seedPost('p3', 'poolB', NOW + 200);

    // A plain member (no governance role): excluded by the role filter.
    await seedUser('memberC');
    await seedPost('p4', 'memberC', NOW + 400);

    // The system author, flagged as a DRep to prove the id exclusion: excluded.
    await seedUser('gov-sync', { isDrep: true });
    await seedPost('p5', 'gov-sync', NOW + 500);

    const ids = await listRecentlyActiveAuthorIds(env.DB, 10);
    expect(ids).toEqual(['drepA', 'poolB']);
  });

  it('ignores deleted and hidden posts for both inclusion and ordering', async () => {
    await seedTopic();

    // Only deleted/hidden posts: excluded entirely.
    await seedUser('drepX', { isDrep: true });
    await seedPost('h1', 'drepX', NOW + 900, { deleted: true });
    await seedPost('h2', 'drepX', NOW + 950, { hidden: true });

    // Old visible post (NOW+100) and a newer hidden one (NOW+800): rank by the visible one.
    await seedUser('drepY', { isDrep: true });
    await seedPost('v1', 'drepY', NOW + 100);
    await seedPost('v2', 'drepY', NOW + 800, { hidden: true });

    // Visible post at NOW+200.
    await seedUser('drepZ', { isDrep: true });
    await seedPost('v3', 'drepZ', NOW + 200);

    const ids = await listRecentlyActiveAuthorIds(env.DB, 10);
    expect(ids).toEqual(['drepZ', 'drepY']);
  });

  it('ignores posts in deleted topics', async () => {
    await seedTopic('t1');
    await seedTopic('tDel', { deleted: true });

    // Only post lives in a deleted topic: excluded.
    await seedUser('drepDeletedTopic', { isDrep: true });
    await seedPost('dp1', 'drepDeletedTopic', NOW + 900, { topicId: 'tDel' });

    // Post in a live topic: included.
    await seedUser('drepLive', { isDrep: true });
    await seedPost('lp1', 'drepLive', NOW + 100, { topicId: 't1' });

    const ids = await listRecentlyActiveAuthorIds(env.DB, 10);
    expect(ids).toEqual(['drepLive']);
  });

  it('respects the limit, newest first', async () => {
    await seedTopic();
    for (let i = 0; i < 5; i++) {
      await seedUser(`d${i}`, { isDrep: true });
      await seedPost(`pp${i}`, `d${i}`, NOW + i);
    }
    const ids = await listRecentlyActiveAuthorIds(env.DB, 3);
    expect(ids).toEqual(['d4', 'd3', 'd2']);
  });
});
