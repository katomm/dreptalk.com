import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listDecidedActionsForRepresentation } from './effectiveRepresentation.js';

async function seedStats(epoch: number, total: string, powered: number) {
  await env.DB.prepare(
    `INSERT INTO governance_epoch_stats (epoch, total_drep_power, powered_drep_count, recently_voting_drep_count,
       gini, top10_share_pct, min_coalition_50, min_coalition_67, votes_cast, vote_data_complete, computed_at)
     VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 1, 0)`,
  ).bind(epoch, total, powered).run();
}

async function seedAction(id: string, decidedEpoch: number | null, over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    id, type: 'InfoAction', title: `Action ${id}`, status: decidedEpoch ? 'ratified' : 'active',
    topic_id: null, created_at: 0, last_synced_at: 0, decided_epoch: decidedEpoch,
    drep_voted_power: 700, drep_yes: 5, drep_no: 2, drep_abstain: 1, ...over,
  };
  const cols = Object.keys(base);
  await env.DB.prepare(
    `INSERT INTO governance_actions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).bind(...cols.map((c) => base[c])).run();
}

describe('listDecidedActionsForRepresentation', () => {
  it('joins the decision epoch stats and orders newest first', async () => {
    await seedStats(540, '1000', 800);
    await seedAction('gaOld', 539);
    await seedAction('gaNew', 540, { drep_voted_power: 640 });
    await seedAction('gaActive', null);
    const rows = await listDecidedActionsForRepresentation(env.DB, { limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(['gaNew', 'gaOld']);
    expect(rows[0].totalDrepPower).toBe('1000');
    expect(rows[0].poweredDrepCount).toBe(800);
    expect(rows[0].votedPower).toBe(640);
    expect(rows[0].votesCast).toBe(8);
    expect(rows[1].totalDrepPower).toBeNull(); // epoch 539 has no stats row
  });

  it('resolves the topic slug when the action has a topic', async () => {
    // topics NOT NULL columns beyond id/slug/title/created_at: category_slug,
    // author_id, last_post_at (no default, unlike pinned/locked/deleted/... below).
    // id is quoted as text: topics.id is TEXT (real ids are UUIDs), and D1
    // sends a bound JS number as SQL REAL, which TEXT affinity would render as
    // "7.0" instead of "7", breaking the join against this literal "7".
    await env.DB.prepare(
      `INSERT INTO topics (id, category_slug, author_id, title, slug, last_post_at, created_at)
       VALUES ('7', 'general', 'author1', 't', 'my-action-slug', 0, 0)`,
    ).run();
    await seedAction('gaT', 540, { topic_id: '7' });
    const rows = await listDecidedActionsForRepresentation(env.DB);
    expect(rows[0].topicSlug).toBe('my-action-slug');
  });
});
