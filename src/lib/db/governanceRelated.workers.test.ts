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
  deleted?: boolean;
}): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
       VALUES (?, 'governance-actions', 'gov-sync', 'governance', ?, ?, 1, ?, ?, ?)`,
    ).bind(o.topicId, `Title ${o.topicId}`, o.topicSlug, NOW, NOW, o.deleted ? 1 : 0),
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
  it('returns same-proposer actions; excludes current, other proposers, and no-topic', async () => {
    // C: the current action (proposer AAA) is excluded by excludeId.
    await seedRow({ actionId: 'C', topicId: 'c-topic', topicSlug: 'c-slug', type: 'TreasuryWithdrawals', returnAddress: 'stakeAAA', submittedEpoch: 530 });

    // P1, P2: same proposer (AAA), different types. Both must be included.
    await seedRow({ actionId: 'P1', topicId: 'p1-topic', topicSlug: 'p1', type: 'InfoAction', returnAddress: 'stakeAAA', submittedEpoch: 540 });
    await seedRow({ actionId: 'P2', topicId: 'p2-topic', topicSlug: 'p2', type: 'ParameterChange', returnAddress: 'stakeAAA', submittedEpoch: 541 });

    // S1: SAME type as C but a DIFFERENT proposer. Type no longer matters, so excluded.
    await seedRow({ actionId: 'S1', topicId: 's1-topic', topicSlug: 's1', type: 'TreasuryWithdrawals', returnAddress: 'stakeBBB', submittedEpoch: 545 });

    // N1: same proposer (AAA) but NO topic row. Excluded by the INNER JOIN.
    await seedActionNoTopic({ actionId: 'N1', type: 'InfoAction', returnAddress: 'stakeAAA' });

    const results = await getRelatedActions(env.DB, {
      excludeId: 'C',
      returnAddress: 'stakeAAA',
    });

    const ids = results.map((r) => r.id);

    // Included: P1 and P2 (same proposer).
    expect(ids).toContain('P1');
    expect(ids).toContain('P2');

    // Excluded: current, same-type-different-proposer, and no-topic.
    expect(ids).not.toContain('C');
    expect(ids).not.toContain('S1');
    expect(ids).not.toContain('N1');

    // Newest first: P2 (epoch 541) before P1 (epoch 540).
    expect(ids.indexOf('P2')).toBeLessThan(ids.indexOf('P1'));
  });

  it('excludes an action whose topic is deleted', async () => {
    // The row would otherwise render a link straight into a 404: the thread page
    // is gone, so the action must not appear in the related list either.
    await seedRow({ actionId: 'D0', topicId: 'd0-topic', topicSlug: 'd0', type: 'InfoAction', returnAddress: 'stakeDDD', submittedEpoch: 600 });
    await seedRow({ actionId: 'D1', topicId: 'd1-topic', topicSlug: 'd1', type: 'InfoAction', returnAddress: 'stakeDDD', submittedEpoch: 601, deleted: true });
    await seedRow({ actionId: 'D2', topicId: 'd2-topic', topicSlug: 'd2', type: 'InfoAction', returnAddress: 'stakeDDD', submittedEpoch: 602 });

    const results = await getRelatedActions(env.DB, {
      excludeId: 'D0',
      returnAddress: 'stakeDDD',
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain('D2');
    expect(ids).not.toContain('D1');
  });

  it('exposes the topic slug for linking', async () => {
    await seedRow({ actionId: 'cur', topicId: 'cur-topic', topicSlug: 'cur-slug', type: 'InfoAction', returnAddress: 'stakeXXX', submittedEpoch: 399 });
    await seedRow({ actionId: 'A2', topicId: 'a2-topic', topicSlug: 'my-action-slug', type: 'InfoAction', returnAddress: 'stakeXXX', submittedEpoch: 400 });

    const results = await getRelatedActions(env.DB, {
      excludeId: 'cur',
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
        returnAddress: 'stakeLIM',
        submittedEpoch: 300 + i,
      });
    }

    const results = await getRelatedActions(env.DB, {
      excludeId: 'lim-0',
      returnAddress: 'stakeLIM',
      limit: 3,
    });
    expect(results.length).toBe(3);
  });

  it('returns empty when the proposer (returnAddress) is null', async () => {
    await seedRow({ actionId: 'nra1', topicId: 'nra1-topic', topicSlug: 'nra1-slug', type: 'NoConfidence', returnAddress: null, submittedEpoch: 350 });
    await seedRow({ actionId: 'nra2', topicId: 'nra2-topic', topicSlug: 'nra2-slug', type: 'NoConfidence', returnAddress: null, submittedEpoch: 360 });

    const results = await getRelatedActions(env.DB, {
      excludeId: 'nra1',
      returnAddress: null,
    });
    // A null proposer cannot be "the same proposer" as anything, so nothing relates.
    expect(results).toEqual([]);
  });

  it('returns empty when the proposer has no other actions', async () => {
    await seedRow({ actionId: 'lone', topicId: 'lone-topic', topicSlug: 'lone-slug', type: 'HardForkInitiation', returnAddress: 'stakeSOLO', submittedEpoch: 200 });

    const results = await getRelatedActions(env.DB, {
      excludeId: 'lone',
      returnAddress: 'stakeSOLO',
    });
    // Only action from this proposer is itself (excluded), so the result is empty.
    expect(results).toEqual([]);
  });
});
