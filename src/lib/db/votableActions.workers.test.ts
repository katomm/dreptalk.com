/// <reference types="@cloudflare/workers-types" />
// Integration test for getVotableActionsForViewer, run in the Workers runtime.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getVotableActionsForViewer } from './votableActions.js';

const drepId = 'drep1testviewer';

// Seed a governance action, optionally linked to a topic.
// Topics have no FK constraint on category_slug, so no category row is needed.
async function seedAction(o: {
  id: string;
  status: string;
  expiryEpoch?: number | null;
  topicId?: string | null;
  topicSlug?: string | null;
}): Promise<void> {
  if (o.topicId && o.topicSlug) {
    await env.DB.prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, created_at, last_post_at, deleted)
       VALUES (?, 'governance-actions', 'system', 'gov_sync', 'Test topic', ?, 1, 0, 0, 0)`,
    )
      .bind(o.topicId, o.topicSlug)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, expiry_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', 'Test action ' || ?, ?, ?, ?, 0, 0)`,
  )
    .bind(o.id, o.id, o.status, o.expiryEpoch ?? null, o.topicId ?? null)
    .run();
}

// Seed a drep_vote row (on-chain or local optimistic).
async function seedVote(gaId: string, vote: string, localStatus: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, block_time, synced_at, local_status, tx_hash)
     VALUES (?, 'DRep', ?, NULL, ?, NULL, NULL, 0, ?, NULL)`,
  )
    .bind(gaId, drepId, vote, localStatus)
    .run();
}

describe('getVotableActionsForViewer', () => {
  it('lists active actions with the viewer vote joined', async () => {
    // Active action the viewer voted on (pending local vote).
    await seedAction({ id: 'ga-active', status: 'active', expiryEpoch: 600 });
    // Expired action: must NOT appear in results (only active).
    await seedAction({ id: 'ga-expired', status: 'expired', expiryEpoch: 400 });
    // Pending local vote on the active action.
    await seedVote('ga-active', 'yes', 'pending');

    const rows = await getVotableActionsForViewer(env.DB, drepId);

    // Only active actions returned.
    expect(rows.every((r) => r.status === 'active')).toBe(true);

    // Non-active action excluded.
    expect(rows.find((r) => r.id === 'ga-expired')).toBeUndefined();

    // The viewer's vote + local status are joined.
    const voted = rows.find((r) => r.viewerVote != null);
    expect(voted).toBeDefined();
    expect(voted?.viewerStatus).toBe('pending');
  });

  it('returns null viewerVote for active actions the viewer has not voted on', async () => {
    await seedAction({ id: 'ga-unvoted', status: 'active', expiryEpoch: 700 });

    const rows = await getVotableActionsForViewer(env.DB, drepId);
    const unvoted = rows.find((r) => r.id === 'ga-unvoted');
    expect(unvoted).toBeDefined();
    expect(unvoted?.viewerVote).toBeNull();
    expect(unvoted?.viewerStatus).toBeNull();
  });

  it('joins the topic slug when a topic exists', async () => {
    await seedAction({ id: 'ga-with-topic', status: 'active', expiryEpoch: 800, topicId: 'topic1', topicSlug: 'some-action' });

    const rows = await getVotableActionsForViewer(env.DB, drepId);
    const row = rows.find((r) => r.id === 'ga-with-topic');
    expect(row?.slug).toBe('some-action');
  });

  it('orders results by expiry_epoch ascending (soonest first)', async () => {
    await seedAction({ id: 'ga-far', status: 'active', expiryEpoch: 1000 });
    await seedAction({ id: 'ga-near', status: 'active', expiryEpoch: 500 });

    const rows = await getVotableActionsForViewer(env.DB, drepId);
    const activeIds = rows.filter((r) => ['ga-far', 'ga-near'].includes(r.id)).map((r) => r.id);
    expect(activeIds.indexOf('ga-near')).toBeLessThan(activeIds.indexOf('ga-far'));
  });
});
