/// <reference types="@cloudflare/workers-types" />
// Governance-action data access tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  buildInsertGovernanceAction,
  getGovernanceActionByTopicId,
  getStaleSyncableActions,
  getAllGovernanceActions,
  getGovernanceActionsByTopicIds,
  getGovernanceActionTopicIdsPage,
  batchUpdateTrendingScores,
  updateGovernanceTallyAndStatus,
  getActionsNeedingVotedPower,
  updateVotedPower,
  getActionsNeedingMetaReextract,
  updateActionMetadata,
  type NewGovernanceAction,
} from './governance.js';
import { getAllTopicsByCategory } from './forum.js';
import { sortGovActionTopics, trendingOrderKey, type GovActionTopic } from '../governance/sort.js';

const GOV = 'governance-actions';

// Seeds a governance topic and its action as one joined row, with full control over
// the columns the list query orders and filters on. Bypasses the higher-level
// builders so a test can set status/decided_epoch/trending_score directly.
async function seedGovRow(o: {
  topicId: string;
  actionId: string;
  categorySlug?: string;
  deleted?: number;
  postCount?: number;
  lastPostAt?: number;
  status?: string;
  submittedEpoch?: number | null;
  expiryEpoch?: number | null;
  decidedEpoch?: number | null;
  trendingScore?: number | null;
  drepYes?: number | null;
}): Promise<void> {
  const categorySlug = o.categorySlug ?? GOV;
  const deleted = o.deleted ?? 0;
  const postCount = o.postCount ?? 1;
  const lastPostAt = o.lastPostAt ?? NOW;
  await db().batch([
    db()
      .prepare(
        `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
         VALUES (?, ?, 'gov-sync', 'governance', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(o.topicId, categorySlug, `Title ${o.topicId}`, `slug-${o.topicId}`, postCount, lastPostAt, lastPostAt, deleted),
    db()
      .prepare(
        `INSERT INTO governance_actions
           (id, type, anchor_status, status, submitted_epoch, expiry_epoch, decided_epoch, drep_yes, trending_score, topic_id, created_at, last_synced_at)
         VALUES (?, 'InfoAction', 'no-anchor', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        o.actionId,
        o.status ?? 'active',
        o.submittedEpoch ?? null,
        o.expiryEpoch ?? null,
        o.decidedEpoch ?? null,
        o.drepYes ?? null,
        o.trendingScore ?? null,
        o.topicId,
        NOW,
        NOW,
      ),
  ]);
}

const db = () => env.DB;
const NOW = 1_753_000_000_000;
const DAY = 86_400_000;

let seq = 0;
async function insertAction(over: Partial<NewGovernanceAction> = {}): Promise<NewGovernanceAction> {
  seq++;
  const a: NewGovernanceAction = {
    id: `tx${seq}#0`,
    proposalId: `gov_action_seq_${seq}`,
    type: 'TreasuryWithdrawals',
    title: `Action ${seq}`,
    abstract: 'abstract',
    rationaleHtml: '<p>why</p>',
    anchorUrl: 'https://example.com/a.json',
    anchorHash: 'hash',
    anchorStatus: 'ok',
    returnAddress: `stake_test_${seq}`,
    deposit: '100000000000',
    submittedEpoch: 287,
    expiryEpoch: 294,
    metaVersion: 0,
    topicId: `topic-${seq}`,
    now: NOW,
    ...over,
  };
  await db().batch([buildInsertGovernanceAction(db(), a)]);
  return a;
}

describe('getGovernanceActionByTopicId', () => {
  it('reads back an inserted action incl. proposal_id', async () => {
    const a = await insertAction();
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(a.id);
    expect(got!.proposalId).toBe(a.proposalId);
    // A freshly discovered action is 'pending' until a sync verifies it.
    expect(got!.status).toBe('pending');
    expect(got!.expiryEpoch).toBe(294);
    expect(got!.drepYesPct).toBeNull();
  });

  it('returns null for an unknown topic', async () => {
    expect(await getGovernanceActionByTopicId(db(), 'nope')).toBeNull();
  });
});

describe('getStaleSyncableActions', () => {
  // Sets a row's tally_synced_at (and status active) so it counts as "synced".
  const markSynced = (id: string, tallySyncedAt: number) =>
    updateGovernanceTallyAndStatus(db(), {
      id, status: 'active',
      drepYes: null, drepNo: null, drepAbstain: null,
      spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
      drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
      ccYesPct: null, ccNoPct: null,
      drepVotedPower: null,
      tallyEpoch: 295, decidedEpoch: null, tallySyncedAt, now: tallySyncedAt,
    });

  it('orders never-synced first, then least-recently-synced, capped by limit', async () => {
    // Two never-synced (tally_synced_at NULL); among them expiry ascending wins.
    const neverLate = await insertAction({ expiryEpoch: 700 });
    const neverEarly = await insertAction({ expiryEpoch: 600 });
    // Two already-synced active actions with different sync times.
    const syncedOld = await insertAction();
    const syncedNew = await insertAction();
    await markSynced(syncedOld.id, NOW - 1000);
    await markSynced(syncedNew.id, NOW);

    const all = await getStaleSyncableActions(db(), 10);
    expect(all.map((r) => r.id)).toEqual([neverEarly.id, neverLate.id, syncedOld.id, syncedNew.id]);

    // Limit caps the result and keeps the highest-priority (never-synced) rows.
    const top2 = await getStaleSyncableActions(db(), 2);
    expect(top2.map((r) => r.id)).toEqual([neverEarly.id, neverLate.id]);
  });

  it('excludes frozen (terminal) actions', async () => {
    const pending = await insertAction();
    const frozen = await insertAction();
    await updateGovernanceTallyAndStatus(db(), {
      id: frozen.id, status: 'expired',
      drepYes: null, drepNo: null, drepAbstain: null,
      spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
      drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
      ccYesPct: null, ccNoPct: null,
      drepVotedPower: null,
      tallyEpoch: 295, decidedEpoch: 295, tallySyncedAt: NOW, now: NOW,
    });
    const ids = (await getStaleSyncableActions(db(), 10)).map((r) => r.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(frozen.id);
  });
});

describe('updateGovernanceTallyAndStatus', () => {
  it('writes pct, counts, tally epoch and synced-at', async () => {
    const a = await insertAction();
    await updateGovernanceTallyAndStatus(db(), {
      id: a.id,
      status: 'active',
      drepYes: 1, drepNo: 1, drepAbstain: 1,
      spoYes: 0, spoNo: 0, spoAbstain: 0,
      ccYes: 0, ccNo: 0, ccAbstain: 0,
      drepYesPct: 0.01, drepNoPct: 99.99, spoYesPct: 0, spoNoPct: 0,
      ccYesPct: 0, ccNoPct: 100,
      drepVotedPower: 3566193128637,
      tallyEpoch: 293, decidedEpoch: 291, tallySyncedAt: NOW + 5, now: NOW + 5,
    });

    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.drepNoPct).toBeCloseTo(99.99);
    expect(got!.drepYes).toBe(1);
    expect(got!.drepVotedPower).toBe(3566193128637);
    expect(got!.tallyEpoch).toBe(293);
    expect(got!.decidedEpoch).toBe(291);
    expect(got!.tallySyncedAt).toBe(NOW + 5);
  });
});

describe('getAllGovernanceActions', () => {
  it('returns every action in one param-less query', async () => {
    const a = await insertAction();
    const b = await insertAction();
    const all = await getAllGovernanceActions(db());
    const ids = all.map((x) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });
});

describe('getGovernanceActionsByTopicIds', () => {
  it('batch-returns only matching topic ids', async () => {
    const a = await insertAction();
    const b = await insertAction();
    const map = await getGovernanceActionsByTopicIds(db(), [a.topicId, b.topicId, 'missing']);
    expect(map.size).toBe(2);
    expect(map.get(a.topicId)!.id).toBe(a.id);
    expect(map.get(b.topicId)!.id).toBe(b.id);
  });

  it('returns an empty map for empty input', async () => {
    const map = await getGovernanceActionsByTopicIds(db(), []);
    expect(map.size).toBe(0);
  });
});

describe('getActionsNeedingVotedPower', () => {
  it('returns only terminal actions with proposal_id and null drep_voted_power', async () => {
    // Terminal action with null power: should be returned.
    const terminal = await insertAction();
    await updateGovernanceTallyAndStatus(db(), {
      id: terminal.id,
      status: 'expired',
      drepYes: 3, drepNo: 1, drepAbstain: 0,
      spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
      drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
      ccYesPct: null, ccNoPct: null,
      drepVotedPower: null,
      tallyEpoch: 295, decidedEpoch: 295, tallySyncedAt: NOW, now: NOW,
    });

    // Active action: excluded (active/pending are handled by normal tally).
    const active = await insertAction();

    // Terminal but already filled: excluded.
    const filled = await insertAction();
    await updateGovernanceTallyAndStatus(db(), {
      id: filled.id,
      status: 'enacted',
      drepYes: 2, drepNo: 0, drepAbstain: 0,
      spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
      drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
      ccYesPct: null, ccNoPct: null,
      drepVotedPower: 999_000_000,
      tallyEpoch: 295, decidedEpoch: 295, tallySyncedAt: NOW, now: NOW,
    });

    const candidates = await getActionsNeedingVotedPower(db(), 10);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(terminal.id);
    expect(ids).not.toContain(active.id);
    expect(ids).not.toContain(filled.id);
  });

  it('respects the limit parameter', async () => {
    // Insert two terminal actions with null power.
    const t1 = await insertAction();
    const t2 = await insertAction();
    for (const id of [t1.id, t2.id]) {
      await updateGovernanceTallyAndStatus(db(), {
        id,
        status: 'dropped',
        drepYes: null, drepNo: null, drepAbstain: null,
        spoYes: null, spoNo: null, spoAbstain: null,
        ccYes: null, ccNo: null, ccAbstain: null,
        drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
        ccYesPct: null, ccNoPct: null,
        drepVotedPower: null,
        tallyEpoch: 296, decidedEpoch: 296, tallySyncedAt: NOW, now: NOW,
      });
    }
    const one = await getActionsNeedingVotedPower(db(), 1);
    expect(one.length).toBe(1);
  });

  it('excludes actions without a proposal_id', async () => {
    const noPid = await insertAction({ proposalId: null });
    await updateGovernanceTallyAndStatus(db(), {
      id: noPid.id,
      status: 'expired',
      drepYes: null, drepNo: null, drepAbstain: null,
      spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
      drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
      ccYesPct: null, ccNoPct: null,
      drepVotedPower: null,
      tallyEpoch: 296, decidedEpoch: 296, tallySyncedAt: NOW, now: NOW,
    });
    const candidates = await getActionsNeedingVotedPower(db(), 10);
    expect(candidates.map((c) => c.id)).not.toContain(noPid.id);
  });
});

describe('updateVotedPower', () => {
  it('sets drep_voted_power without touching status', async () => {
    const a = await insertAction();
    await updateGovernanceTallyAndStatus(db(), {
      id: a.id,
      status: 'ratified',
      drepYes: 4, drepNo: 0, drepAbstain: 0,
      spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
      drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
      ccYesPct: null, ccNoPct: null,
      drepVotedPower: null,
      tallyEpoch: 297, decidedEpoch: 297, tallySyncedAt: NOW, now: NOW,
    });

    await updateVotedPower(db(), a.id, 5_000_000_000);

    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.drepVotedPower).toBe(5_000_000_000);
    // Status must not have been touched.
    expect(got!.status).toBe('ratified');
    // Other tally fields must be unchanged.
    expect(got!.drepYes).toBe(4);
  });
});

describe('getActionsNeedingMetaReextract', () => {
  it('returns only actions with anchor_url set and meta_version below currentVersion', async () => {
    // Stale: has anchor and meta_version 0.
    const stale = await insertAction({ anchorUrl: 'https://example.com/doc.json', anchorHash: 'abc', metaVersion: 0 });
    // Already current: same anchor but meta_version matches currentVersion.
    const current = await insertAction({ anchorUrl: 'https://example.com/doc2.json', anchorHash: 'def', metaVersion: 1 });
    // No anchor: must be excluded regardless of meta_version.
    const noAnchor = await insertAction({ anchorUrl: null, anchorHash: null, metaVersion: 0 });

    const candidates = await getActionsNeedingMetaReextract(db(), 1, 100);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(current.id);
    expect(ids).not.toContain(noAnchor.id);
  });

  it('respects the limit parameter', async () => {
    // Insert two stale rows.
    await insertAction({ anchorUrl: 'https://example.com/x1.json', anchorHash: 'h1', metaVersion: 0 });
    await insertAction({ anchorUrl: 'https://example.com/x2.json', anchorHash: 'h2', metaVersion: 0 });

    const one = await getActionsNeedingMetaReextract(db(), 1, 1);
    expect(one.length).toBe(1);
  });

  it('returns an empty list when all actions are current or anchor-less', async () => {
    await insertAction({ anchorUrl: 'https://example.com/y.json', anchorHash: 'hh', metaVersion: 1 });
    await insertAction({ anchorUrl: null, anchorHash: null, metaVersion: 0 });

    const candidates = await getActionsNeedingMetaReextract(db(), 1, 100);
    // Any rows from this test iteration are already current or anchor-less.
    for (const c of candidates) {
      expect(c.metaVersion).toBeLessThan(1);
      expect(c.anchorUrl).not.toBeNull();
    }
  });
});

describe('updateActionMetadata', () => {
  it('writes title/abstract/rationale_html and meta_version without touching other columns', async () => {
    const a = await insertAction({ metaVersion: 0 });
    // Give the action a non-default status to verify surgical update.
    await updateGovernanceTallyAndStatus(db(), {
      id: a.id,
      status: 'active',
      drepYes: 7, drepNo: 2, drepAbstain: 1,
      spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
      drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
      ccYesPct: null, ccNoPct: null,
      drepVotedPower: null,
      tallyEpoch: 300, decidedEpoch: null, tallySyncedAt: NOW, now: NOW,
    });

    await updateActionMetadata(db(), a.id, {
      title: 'Updated Title',
      abstract: 'New abstract with newlines.',
      rationaleHtml: '<p>Rationale paragraph.</p>',
      metaVersion: 1,
    });

    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.title).toBe('Updated Title');
    expect(got!.abstract).toBe('New abstract with newlines.');
    expect(got!.rationaleHtml).toBe('<p>Rationale paragraph.</p>');
    expect(got!.metaVersion).toBe(1);
    // Surgical: status and tallies must be unchanged.
    expect(got!.status).toBe('active');
    expect(got!.drepYes).toBe(7);
    expect(got!.tallyEpoch).toBe(300);
  });

  it('allows null metadata fields (legitimately empty anchor doc)', async () => {
    const a = await insertAction({ metaVersion: 0 });
    await updateActionMetadata(db(), a.id, {
      title: null,
      abstract: null,
      rationaleHtml: null,
      metaVersion: 1,
    });
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.title).toBeNull();
    expect(got!.abstract).toBeNull();
    expect(got!.rationaleHtml).toBeNull();
    expect(got!.metaVersion).toBe(1);
  });
});

describe('getGovernanceActionTopicIdsPage', () => {
  it('trending: stored score desc, then submitted epoch desc, then topic id; NULL scores last', async () => {
    await seedGovRow({ topicId: 't-low', actionId: 'a1', trendingScore: 10, submittedEpoch: 500 });
    await seedGovRow({ topicId: 't-high', actionId: 'a2', trendingScore: 30, submittedEpoch: 500 });
    await seedGovRow({ topicId: 't-mid', actionId: 'a3', trendingScore: 20, submittedEpoch: 500 });
    // Equal score to t-mid: the newer submitted epoch wins the tiebreak.
    await seedGovRow({ topicId: 't-tieB', actionId: 'a4', trendingScore: 20, submittedEpoch: 510 });
    // No score yet (un-backfilled): sinks to the end despite the newest epoch.
    await seedGovRow({ topicId: 't-null', actionId: 'a5', trendingScore: null, submittedEpoch: 999 });

    const { topicIds, total } = await getGovernanceActionTopicIdsPage(db(), {
      categorySlug: GOV,
      sort: 'trending',
      limit: 100,
      offset: 0,
    });
    expect(topicIds).toEqual(['t-high', 't-tieB', 't-mid', 't-low', 't-null']);
    expect(total).toBe(5);
  });

  it('new: newest submitted epoch first, NULL epochs last, all statuses', async () => {
    await seedGovRow({ topicId: 't-300', actionId: 'a1', submittedEpoch: 300, status: 'enacted' });
    await seedGovRow({ topicId: 't-320', actionId: 'a2', submittedEpoch: 320 });
    await seedGovRow({ topicId: 't-310', actionId: 'a3', submittedEpoch: 310, status: 'expired' });
    await seedGovRow({ topicId: 't-nil', actionId: 'a4', submittedEpoch: null });

    const { topicIds } = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'new', limit: 100, offset: 0 });
    expect(topicIds).toEqual(['t-320', 't-310', 't-300', 't-nil']);
  });

  it('closing: open actions only, soonest expiry first, NULL expiry last, terminal excluded', async () => {
    await seedGovRow({ topicId: 't-far', actionId: 'a1', status: 'active', expiryEpoch: 400 });
    await seedGovRow({ topicId: 't-soon', actionId: 'a2', status: 'active', expiryEpoch: 360 });
    await seedGovRow({ topicId: 't-noexp', actionId: 'a3', status: 'pending', expiryEpoch: null });
    await seedGovRow({ topicId: 't-enacted', actionId: 'a4', status: 'enacted', expiryEpoch: 350 });
    await seedGovRow({ topicId: 't-expired', actionId: 'a5', status: 'expired', expiryEpoch: 355 });

    const { topicIds, total } = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'closing', limit: 100, offset: 0 });
    // Terminal rows are dropped even though their expiry is soonest; the count matches.
    expect(topicIds).toEqual(['t-soon', 't-far', 't-noexp']);
    expect(total).toBe(3);
  });

  it('ratified: most recently decided first, NULL decided last', async () => {
    await seedGovRow({ topicId: 't-active', actionId: 'a1', status: 'active', decidedEpoch: null });
    await seedGovRow({ topicId: 't-500', actionId: 'a2', status: 'enacted', decidedEpoch: 500 });
    await seedGovRow({ topicId: 't-520', actionId: 'a3', status: 'ratified', decidedEpoch: 520 });

    const { topicIds } = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'ratified', limit: 100, offset: 0 });
    expect(topicIds).toEqual(['t-520', 't-500', 't-active']);
  });

  it('paginates with limit/offset while total stays the full count', async () => {
    for (let i = 0; i < 5; i++) {
      await seedGovRow({ topicId: `t-${i}`, actionId: `a-${i}`, trendingScore: 100 - i, submittedEpoch: 500 });
    }
    const p1 = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'trending', limit: 2, offset: 0 });
    expect(p1.topicIds).toEqual(['t-0', 't-1']);
    expect(p1.total).toBe(5);
    const p2 = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'trending', limit: 2, offset: 2 });
    expect(p2.topicIds).toEqual(['t-2', 't-3']);
    const p3 = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'trending', limit: 2, offset: 4 });
    expect(p3.topicIds).toEqual(['t-4']);
    expect(p3.total).toBe(5);
  });

  it('excludes deleted topics, other categories, and actions whose topic is missing', async () => {
    await seedGovRow({ topicId: 't-ok', actionId: 'a-ok', trendingScore: 50 });
    await seedGovRow({ topicId: 't-del', actionId: 'a-del', trendingScore: 99, deleted: 1 });
    await seedGovRow({ topicId: 't-other', actionId: 'a-other', trendingScore: 99, categorySlug: 'general' });
    // Action pointing at a non-existent topic: the inner join drops it.
    await db()
      .prepare(
        `INSERT INTO governance_actions (id, type, anchor_status, status, trending_score, topic_id, created_at, last_synced_at)
         VALUES ('a-orphan', 'InfoAction', 'no-anchor', 'active', 99, 'nope', ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();

    const { topicIds, total } = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'trending', limit: 100, offset: 0 });
    expect(topicIds).toEqual(['t-ok']);
    expect(total).toBe(1);
  });

  it('trending order matches the in-memory sortGovActionTopics oracle', async () => {
    // A representative mixed set: whale (old, vote-heavy), fresh, hot discussion, a
    // terminal action, and a quiet older one. Distinct scores, so the equivalence is
    // unambiguous.
    await seedGovRow({ topicId: 't-whale', actionId: 'w', status: 'active', postCount: 1, drepYes: 2000, lastPostAt: NOW - 40 * DAY, submittedEpoch: 500 });
    await seedGovRow({ topicId: 't-fresh', actionId: 'f', status: 'active', postCount: 1, drepYes: 0, lastPostAt: NOW - 2 * DAY, submittedEpoch: 540 });
    await seedGovRow({ topicId: 't-hot', actionId: 'h', status: 'active', postCount: 5, drepYes: 50, lastPostAt: NOW - 5 * DAY, submittedEpoch: 535 });
    await seedGovRow({ topicId: 't-enacted', actionId: 'e', status: 'enacted', postCount: 3, drepYes: 10, lastPostAt: NOW - 3 * DAY, submittedEpoch: 520 });
    await seedGovRow({ topicId: 't-quiet', actionId: 'q', status: 'active', postCount: 1, drepYes: 0, lastPostAt: NOW - 20 * DAY, submittedEpoch: 510 });

    // Oracle = the old page path: load all, join, sort in memory.
    const topics = await getAllTopicsByCategory(db(), GOV);
    const actions = await getAllGovernanceActions(db());
    const byTopic = new Map(actions.filter((a) => a.topicId).map((a) => [a.topicId!, a]));
    const rows = topics
      .map((t) => ({ topic: t, action: byTopic.get(t.id) }))
      .filter((r): r is GovActionTopic => !!r.action);
    const expected = sortGovActionTopics(rows, 'trending', NOW).map((r) => r.topic.id);

    // Materialize the scores exactly as the cron will, then read the paged order back.
    await batchUpdateTrendingScores(db(), rows.map((r) => ({ id: r.action.id, score: trendingOrderKey(r) })));
    const { topicIds } = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'trending', limit: 100, offset: 0 });

    expect(topicIds).toEqual(expected);
  });
});

describe('batchUpdateTrendingScores', () => {
  it('writes scores and round-trips them exactly', async () => {
    await seedGovRow({ topicId: 't1', actionId: 'a1', trendingScore: null });
    await seedGovRow({ topicId: 't2', actionId: 'a2', trendingScore: null });

    await batchUpdateTrendingScores(db(), [
      { id: 'a1', score: 2893.5 },
      { id: 'a2', score: 1234.0625 },
    ]);

    expect((await getGovernanceActionByTopicId(db(), 't1'))!.trendingScore).toBe(2893.5);
    expect((await getGovernanceActionByTopicId(db(), 't2'))!.trendingScore).toBe(1234.0625);
  });

  it('is a no-op for an empty update list', async () => {
    await seedGovRow({ topicId: 't1', actionId: 'a1', trendingScore: 5 });
    await batchUpdateTrendingScores(db(), []);
    expect((await getGovernanceActionByTopicId(db(), 't1'))!.trendingScore).toBe(5);
  });
});
