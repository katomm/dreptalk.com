/// <reference types="@cloudflare/workers-types" />
// Workers-runtime integration tests for getRelatedActions.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getRelatedActions } from './governance.js';

const NOW = 1_753_000_000_000;

/** Seeds one topic row and one governance_actions row atomically. */
async function seedRow(o: {
  actionId: string;
  topicId: string;
  topicSlug: string;
  type: string;
  returnAddress: string | null;
  submittedEpoch: number | null;
  status?: string;
}): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
       VALUES (?, 'governance-actions', 'gov-sync', 'governance', ?, ?, 1, ?, ?, 0)`,
    ).bind(o.topicId, `Title ${o.topicId}`, o.topicSlug, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO governance_actions
         (id, type, status, return_address, submitted_epoch, topic_id, created_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      o.actionId,
      o.type,
      o.status ?? 'active',
      o.returnAddress,
      o.submittedEpoch,
      o.topicId,
      NOW,
      NOW,
    ),
  ]);
}

/** Seeds a governance_actions row with NO matching topic (to test JOIN exclusion). */
async function seedActionNoTopic(o: {
  actionId: string;
  type: string;
  returnAddress: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO governance_actions
       (id, type, status, return_address, submitted_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, ?, 'active', ?, NULL, NULL, ?, ?)`,
  )
    .bind(o.actionId, o.type, o.returnAddress, NOW, NOW)
    .run();
}

describe('getRelatedActions', () => {
  it('returns same-type and same-proposer actions, excludes current, unrelated, and no-topic', async () => {
    // C: the current action (will be excluded by excludeId).
    await seedRow({ actionId: 'C', topicId: 'c-topic', topicSlug: 'c-slug', type: 'TreasuryWithdrawals', returnAddress: 'stakeAAA', submittedEpoch: 530 });

    // S1: same type, different proposer. submitted_epoch 540.
    await seedRow({ actionId: 'S1', topicId: 's1-topic', topicSlug: 's1', type: 'TreasuryWithdrawals', returnAddress: 'stakeBBB', submittedEpoch: 540 });

    // P1: different type, same proposer (stakeAAA). submitted_epoch 541.
    await seedRow({ actionId: 'P1', topicId: 'p1-topic', topicSlug: 'p1', type: 'InfoAction', returnAddress: 'stakeAAA', submittedEpoch: 541 });

    // U1: different type, unrelated proposer. Must be excluded entirely.
    await seedRow({ actionId: 'U1', topicId: 'u1-topic', topicSlug: 'u1', type: 'InfoAction', returnAddress: 'stakeZZZ', submittedEpoch: 550 });

    // N1: same type, but NO topic row. Must be excluded by the INNER JOIN.
    await seedActionNoTopic({ actionId: 'N1', type: 'TreasuryWithdrawals', returnAddress: 'stakeNNN' });

    const results = await getRelatedActions(env.DB, {
      excludeId: 'C',
      type: 'TreasuryWithdrawals',
      returnAddress: 'stakeAAA',
    });

    const ids = results.map((r) => r.id);

    // Included: S1 (same type) and P1 (same proposer).
    expect(ids).toContain('S1');
    expect(ids).toContain('P1');

    // Excluded: current action, unrelated, and no-topic action.
    expect(ids).not.toContain('C');
    expect(ids).not.toContain('U1');
    expect(ids).not.toContain('N1');

    // S1 comes before P1: same-type rows sort first.
    expect(ids.indexOf('S1')).toBeLessThan(ids.indexOf('P1'));
  });

  it('exposes the topic slug for linking', async () => {
    await seedRow({ actionId: 'A2', topicId: 'a2-topic', topicSlug: 'my-action-slug', type: 'InfoAction', returnAddress: 'stakeXXX', submittedEpoch: 400 });
    await seedRow({ actionId: 'A3', topicId: 'a3-topic', topicSlug: 'other-slug', type: 'InfoAction', returnAddress: 'stakeYYY', submittedEpoch: 401 });

    const results = await getRelatedActions(env.DB, {
      excludeId: 'A3',
      type: 'InfoAction',
      returnAddress: 'stakeXXX',
    });

    const a2 = results.find((r) => r.id === 'A2');
    expect(a2).toBeDefined();
    expect(a2!.topic_slug).toBe('my-action-slug');
  });

  it('respects the limit cap', async () => {
    for (let i = 0; i < 10; i++) {
      await seedRow({
        actionId: `lim-${i}`,
        topicId: `lim-topic-${i}`,
        topicSlug: `lim-slug-${i}`,
        type: 'ParameterChange',
        returnAddress: null,
        submittedEpoch: 300 + i,
      });
    }

    const results = await getRelatedActions(env.DB, {
      excludeId: 'lim-0',
      type: 'ParameterChange',
      returnAddress: null,
      limit: 3,
    });
    expect(results.length).toBe(3);
  });

  it('returns empty when no related actions exist', async () => {
    await seedRow({ actionId: 'lone', topicId: 'lone-topic', topicSlug: 'lone-slug', type: 'HardForkInitiation', returnAddress: 'stakeSOLO', submittedEpoch: 200 });

    const results = await getRelatedActions(env.DB, {
      excludeId: 'lone',
      type: 'HardForkInitiation',
      returnAddress: 'stakeSOLO',
    });
    // Only action of this type/proposer is itself (excluded), so result is empty.
    expect(results).toEqual([]);
  });

  it('works when returnAddress is null (matches by type only)', async () => {
    await seedRow({ actionId: 'nra1', topicId: 'nra1-topic', topicSlug: 'nra1-slug', type: 'NoConfidence', returnAddress: null, submittedEpoch: 350 });
    await seedRow({ actionId: 'nra2', topicId: 'nra2-topic', topicSlug: 'nra2-slug', type: 'NoConfidence', returnAddress: null, submittedEpoch: 360 });

    const results = await getRelatedActions(env.DB, {
      excludeId: 'nra1',
      type: 'NoConfidence',
      returnAddress: null,
    });
    expect(results.map((r) => r.id)).toContain('nra2');
  });
});
