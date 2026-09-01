/// <reference types="@cloudflare/workers-types" />
// Governance-action data access tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  buildInsertGovernanceAction,
  getGovernanceActionByTopicId,
  getStaleSyncableActions,
  getVoteStaleSyncableActions,
  getAllGovernanceActions,
  getGovernanceActionsByTopicIds,
  getGovernanceActionTopicIdsPage,
  batchUpdateTrendingScores,
  updateGovernanceTallyAndStatus,
  getActionsNeedingVotedPower,
  updateVotedPower,
  getActionsNeedingThresholdSnapshot,
  updateThresholdSnapshot,
  getActionsNeedingMetaReextract,
  countGivenUpMetaActions,
  updateActionMetadata,
  getGovActionsWithStaleTopicTitle,
  getActionsNeedingVoteBackfill,
  markVotesSynced,
  getActionIdsMissingOnchainPayload,
  updateActionOnchainPayload,
  getLatestActionWithVotes,
  getGovernanceActionSlugsByIds,
  getKnownProposalIds,
  getCompareCandidates,
  getCompareActionBySlug,
  type NewGovernanceAction,
} from './governance.js';
import { getAllTopicsByCategory } from './forum.js';
import { D1_MAX_BINDS } from './sql.js';
import { sortGovActionTopics, trendingOrderKey, type GovActionTopic } from '../governance/sort.js';
import { THRESHOLD_SNAPSHOT_VERSION } from '../governance/thresholds.js';

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
  type?: string;
  submittedEpoch?: number | null;
  submittedAt?: number | null;
  expiryEpoch?: number | null;
  decidedEpoch?: number | null;
  trendingScore?: number | null;
  drepYes?: number | null;
  drepYesPct?: number | null;
  spoYesPct?: number | null;
  ccYesPct?: number | null;
  /** Action title; left null by default so list queries that filter it out still apply. */
  title?: string | null;
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
           (id, type, anchor_status, status, title, submitted_epoch, submitted_at, expiry_epoch, decided_epoch, drep_yes, drep_yes_pct, spo_yes_pct, cc_yes_pct, trending_score, topic_id, created_at, last_synced_at)
         VALUES (?, ?, 'no-anchor', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        o.actionId,
        o.type ?? 'InfoAction',
        o.status ?? 'active',
        o.title ?? null,
        o.submittedEpoch ?? null,
        o.submittedAt ?? null,
        o.expiryEpoch ?? null,
        o.decidedEpoch ?? null,
        o.drepYes ?? null,
        o.drepYesPct ?? null,
        o.spoYesPct ?? null,
        o.ccYesPct ?? null,
        o.trendingScore ?? null,
        o.topicId,
        NOW,
        NOW,
      ),
  ]);
}

// A single vote row, enough to exercise the compare-eligibility EXISTS gate.
// votedPower null models a pre-backfill DRep row, localStatus 'failed' models an
// optimistic local vote that never made it on chain, vote 'No' models an action
// nobody supported. None of them may qualify an action: the trend draws rising yes
// support, so a chart with no yes vote has no curve to draw.
async function seedVote(
  gaId: string,
  o: {
    votedPower?: number | null;
    role?: string;
    blockTime?: number | null;
    localStatus?: string | null;
    vote?: string;
  } = {},
): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, block_time, synced_at, voted_power, local_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      gaId,
      o.role ?? 'DRep',
      `voter-${gaId}`,
      o.vote ?? 'Yes',
      o.blockTime === undefined ? 1_753_000 : o.blockTime,
      NOW,
      o.votedPower === undefined ? 1_000 : o.votedPower,
      o.localStatus ?? null,
    )
    .run();
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
    authors: null,
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
      thresholdsJson: null, thresholdsEpoch: null,
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
      thresholdsJson: null, thresholdsEpoch: null,
    });
    const ids = (await getStaleSyncableActions(db(), 10)).map((r) => r.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(frozen.id);
  });
});

describe('getVoteStaleSyncableActions', () => {
  // Marks a row active with a tally sync time, then sets its vote sync time
  // separately so the two timestamps can diverge (the whole point of the query).
  const markTallySynced = (id: string, tallySyncedAt: number) =>
    updateGovernanceTallyAndStatus(db(), {
      id, status: 'active',
      drepYes: null, drepNo: null, drepAbstain: null,
      spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
      drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
      ccYesPct: null, ccNoPct: null,
      drepVotedPower: null,
      tallyEpoch: 295, decidedEpoch: null, tallySyncedAt, now: tallySyncedAt,
      thresholdsJson: null, thresholdsEpoch: null,
    });

  it('orders by vote recency, independent of tally recency', async () => {
    // freshTallyStaleVotes has the newest tally but the oldest (never) vote sync:
    // tally-ordering would bury it, vote-ordering must surface it first.
    const freshTallyStaleVotes = await insertAction({ expiryEpoch: 600 });
    const oldTallyFreshVotes = await insertAction({ expiryEpoch: 700 });
    await markTallySynced(freshTallyStaleVotes.id, NOW);
    await markTallySynced(oldTallyFreshVotes.id, NOW - 10_000);
    // Only the second one has ever been vote-synced.
    await markVotesSynced(db(), oldTallyFreshVotes.id, NOW);

    const ids = (await getVoteStaleSyncableActions(db(), 10)).map((r) => r.id);
    expect(ids).toEqual([freshTallyStaleVotes.id, oldTallyFreshVotes.id]);
  });

  it('excludes frozen (terminal) actions', async () => {
    const active = await insertAction();
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
      thresholdsJson: null, thresholdsEpoch: null,
    });
    const ids = (await getVoteStaleSyncableActions(db(), 10)).map((r) => r.id);
    expect(ids).toContain(active.id);
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
      thresholdsJson: null, thresholdsEpoch: null,
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

describe('getGovernanceActionSlugsByIds', () => {
  it('resolves the slug for an action with a live topic', async () => {
    await seedGovRow({ topicId: 'slug-live', actionId: 'ga-slug-live' });

    const map = await getGovernanceActionSlugsByIds(db(), ['ga-slug-live']);

    expect(map.get('ga-slug-live')).toBe('slug-slug-live');
  });

  it('resolves no slug for an action whose topic is deleted', async () => {
    // The notification stays in the inbox, it just stops linking into a 404.
    await seedGovRow({ topicId: 'slug-gone', actionId: 'ga-slug-gone', deleted: 1 });

    const map = await getGovernanceActionSlugsByIds(db(), ['ga-slug-gone']);

    expect(map.get('ga-slug-gone')).toBeNull();
  });

  it('keeps an entry for an action that has no topic at all', async () => {
    // The null-slug contract the callers rely on: every requested id is present,
    // so a topicless action is distinguishable from an id that does not exist.
    await db()
      .prepare(
        `INSERT INTO governance_actions (id, type, anchor_status, status, topic_id, created_at, last_synced_at)
         VALUES ('ga-no-topic', 'InfoAction', 'no-anchor', 'active', NULL, ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();

    const map = await getGovernanceActionSlugsByIds(db(), ['ga-no-topic']);

    expect(map.has('ga-no-topic')).toBe(true);
    expect(map.get('ga-no-topic')).toBeNull();
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

describe('getKnownProposalIds', () => {
  it('unions matches across chunk boundaries', async () => {
    // The surveys sync asks about every gov link on a Tessera page — 200 surveys
    // with one-or-more links each — so the id list spans several chunks. Miniflare
    // does not enforce D1's bind cap, so what this pins is the merge: no chunk,
    // least of all a short trailing one, may be dropped from the union.
    const total = 2 * D1_MAX_BINDS + 7;
    const imported: string[] = [];
    for (let i = 0; i < total; i++) {
      const proposalId = `gov_action_known${i}`;
      imported.push(proposalId);
      await db()
        .prepare(
          `INSERT INTO governance_actions (id, type, anchor_status, status, topic_id, proposal_id, created_at, last_synced_at)
           VALUES (?, 'InfoAction', 'no-anchor', 'active', NULL, ?, ?, ?)`,
        )
        .bind(`ga-known-${i}`, proposalId, NOW, NOW)
        .run();
    }

    const known = await getKnownProposalIds(db(), [...imported, 'gov_action_absent']);

    expect(known.size).toBe(total);
    expect(known.has(imported[0])).toBe(true);
    expect(known.has(imported[D1_MAX_BINDS])).toBe(true);
    expect(known.has(imported[total - 1])).toBe(true);
    expect(known.has('gov_action_absent')).toBe(false);
  });

  it('queries nothing for an empty id list', async () => {
    expect((await getKnownProposalIds(db(), [])).size).toBe(0);
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
      thresholdsJson: null, thresholdsEpoch: null,
    });

    // Active action: excluded (active/pending are handled by normal tally).
    const active = await insertAction();

    // Terminal but already filled (turnout, per-option power, eligible SPO stake
    // AND the four default-option power fields): excluded.
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
      drepYesPower: 999_000_000, drepNoPower: 0, drepAbstainPower: 0,
      spoEligiblePower: 5_000_000_000,
      drepAlwaysAbstainPower: '0', drepAlwaysNoConfidencePower: '0',
      spoAlwaysAbstainPower: '0', spoAlwaysNoConfidencePower: '0',
      drepNoSidePower: '0', spoNoSidePower: '0',
      tallyEpoch: 295, decidedEpoch: 295, tallySyncedAt: NOW, now: NOW,
      thresholdsJson: null, thresholdsEpoch: null,
    });

    // Terminal with turnout+power but null eligible SPO stake (older row from before
    // the column existed): now returned so the backfill fills it and corrects SPO power.
    const needsEligible = await insertAction();
    await updateGovernanceTallyAndStatus(db(), {
      id: needsEligible.id,
      status: 'enacted',
      drepYes: 2, drepNo: 0, drepAbstain: 0,
      spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
      drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
      ccYesPct: null, ccNoPct: null,
      drepVotedPower: 999_000_000,
      drepYesPower: 999_000_000, drepNoPower: 0, drepAbstainPower: 0,
      spoEligiblePower: null,
      tallyEpoch: 295, decidedEpoch: 295, tallySyncedAt: NOW, now: NOW,
      thresholdsJson: null, thresholdsEpoch: null,
    });

    const candidates = await getActionsNeedingVotedPower(db(), 10);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(terminal.id);
    expect(ids).toContain(needsEligible.id);
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
        thresholdsJson: null, thresholdsEpoch: null,
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
      thresholdsJson: null, thresholdsEpoch: null,
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
      thresholdsJson: null, thresholdsEpoch: null,
    });

    await updateVotedPower(db(), a.id, { votedPower: 5_000_000_000, drepYesPower: 5_000_000_000 });

    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.drepVotedPower).toBe(5_000_000_000);
    expect(got!.drepYesPower).toBe(5_000_000_000);
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

    const candidates = await getActionsNeedingMetaReextract(db(), 1, 100, 10);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(current.id);
    expect(ids).not.toContain(noAnchor.id);
  });

  it('respects the limit parameter', async () => {
    // Insert two stale rows.
    await insertAction({ anchorUrl: 'https://example.com/x1.json', anchorHash: 'h1', metaVersion: 0 });
    await insertAction({ anchorUrl: 'https://example.com/x2.json', anchorHash: 'h2', metaVersion: 0 });

    const one = await getActionsNeedingMetaReextract(db(), 1, 1, 10);
    expect(one.length).toBe(1);
  });

  it('returns an empty list when all actions are current or anchor-less', async () => {
    await insertAction({ anchorUrl: 'https://example.com/y.json', anchorHash: 'hh', metaVersion: 1 });
    await insertAction({ anchorUrl: null, anchorHash: null, metaVersion: 0 });

    const candidates = await getActionsNeedingMetaReextract(db(), 1, 100, 10);
    // Any rows from this test iteration are already current or anchor-less.
    for (const c of candidates) {
      expect(c.metaVersion).toBeLessThan(1);
      expect(c.anchorUrl).not.toBeNull();
    }
  });

  it('excludes rows whose meta_attempts reached the give-up cap', async () => {
    const live = await insertAction({ anchorUrl: 'https://example.com/live.json', anchorHash: 'aa', metaVersion: 0 });
    const giveUp = await insertAction({ anchorUrl: 'https://example.com/dead.json', anchorHash: 'bb', metaVersion: 0 });
    // Push the second row to the cap so the backfill should give up on it.
    await db().prepare('UPDATE governance_actions SET meta_attempts = ? WHERE id = ?').bind(10, giveUp.id).run();

    const candidates = await getActionsNeedingMetaReextract(db(), 1, 100, 10);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(giveUp.id);
  });

  it('returns a row whose anchor failed even when meta_version is already current', async () => {
    // The latent bug: an anchor that failed at discovery is stamped at the current
    // version, so meta_version < currentVersion never matches and it is never retried.
    // It must still be picked up because its anchor_status is not 'ok'.
    const failedCurrent = await insertAction({
      anchorUrl: 'https://example.com/failed-current.json', anchorHash: 'fc', anchorStatus: 'fetch-failed', metaVersion: 1,
    });
    // A successfully-extracted current row has nothing to do and must NOT be retried.
    const okCurrent = await insertAction({
      anchorUrl: 'https://example.com/ok-current.json', anchorHash: 'oc', anchorStatus: 'ok', metaVersion: 1,
    });

    const ids = (await getActionsNeedingMetaReextract(db(), 1, 100, 10)).map((c) => c.id);
    expect(ids).toContain(failedCurrent.id);
    expect(ids).not.toContain(okCurrent.id);
  });

  it('stops retrying a failed-anchor current-version row once it hits the give-up cap', async () => {
    const dead = await insertAction({
      anchorUrl: 'https://example.com/failed-dead.json', anchorHash: 'fd', anchorStatus: 'fetch-failed', metaVersion: 1,
    });
    await db().prepare('UPDATE governance_actions SET meta_attempts = ? WHERE id = ?').bind(10, dead.id).run();
    const ids = (await getActionsNeedingMetaReextract(db(), 1, 100, 10)).map((c) => c.id);
    expect(ids).not.toContain(dead.id);
  });
});

describe('countGivenUpMetaActions', () => {
  it('counts only stale, anchored rows at or past the give-up cap', async () => {
    // Delta-based: other tests in this file also seed rows, so measure the change.
    const before = await countGivenUpMetaActions(db(), 1, 10);

    const dead = await insertAction({ anchorUrl: 'https://example.com/g1.json', anchorHash: 'g1', metaVersion: 0 });
    await db().prepare('UPDATE governance_actions SET meta_attempts = ? WHERE id = ?').bind(10, dead.id).run();

    // Below the cap: still being retried, must not count.
    await insertAction({ anchorUrl: 'https://example.com/g2.json', anchorHash: 'g2', metaVersion: 0 });
    // Already current: nothing to re-extract, must not count.
    await insertAction({ anchorUrl: 'https://example.com/g3.json', anchorHash: 'g3', metaVersion: 1 });
    // Anchor-less even past the cap: no anchor to give up on, must not count.
    const anchorless = await insertAction({ anchorUrl: null, anchorHash: null, metaVersion: 0 });
    await db().prepare('UPDATE governance_actions SET meta_attempts = ? WHERE id = ?').bind(20, anchorless.id).run();

    const after = await countGivenUpMetaActions(db(), 1, 10);
    expect(after - before).toBe(1);
  });

  it('counts a failed-anchor row at the cap even when its meta_version is current', async () => {
    const before = await countGivenUpMetaActions(db(), 1, 10);
    const dead = await insertAction({
      anchorUrl: 'https://example.com/gu-failed.json', anchorHash: 'guf', anchorStatus: 'fetch-failed', metaVersion: 1,
    });
    await db().prepare('UPDATE governance_actions SET meta_attempts = ? WHERE id = ?').bind(10, dead.id).run();
    const after = await countGivenUpMetaActions(db(), 1, 10);
    expect(after - before).toBe(1);
  });
});

describe('getGovActionsWithStaleTopicTitle', () => {
  it('returns gov actions whose topic title differs from the action title', async () => {
    // seedGovRow sets the topic title to `Title <topicId>` and the action title to o.title.
    await seedGovRow({ topicId: 'stale-tt', actionId: 'stale-tt#0', title: 'Real Anchor Title' });
    // Action title equals the seeded topic title: not stale, must be excluded.
    await seedGovRow({ topicId: 'match-tt', actionId: 'match-tt#0', title: 'Title match-tt' });
    // Null action title (only a fallback exists): nothing to sync, must be excluded.
    await seedGovRow({ topicId: 'null-tt', actionId: 'null-tt#0', title: null });

    const ids = (await getGovActionsWithStaleTopicTitle(db(), 100)).map((a) => a.id);
    expect(ids).toContain('stale-tt#0');
    expect(ids).not.toContain('match-tt#0');
    expect(ids).not.toContain('null-tt#0');
  });

  it('excludes a row once its topic title has been reconciled', async () => {
    await seedGovRow({ topicId: 'fixed-tt', actionId: 'fixed-tt#0', title: 'Synced Title' });
    await db().prepare('UPDATE topics SET title = ? WHERE id = ?').bind('Synced Title', 'fixed-tt').run();
    const ids = (await getGovActionsWithStaleTopicTitle(db(), 100)).map((a) => a.id);
    expect(ids).not.toContain('fixed-tt#0');
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
      thresholdsJson: null, thresholdsEpoch: null,
    });

    await updateActionMetadata(db(), a.id, {
      title: 'Updated Title',
      abstract: 'New abstract with newlines.',
      rationaleHtml: '<p>Rationale paragraph.</p>',
      authors: null,
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

  it('clears a failed anchor_status back to ok on a successful re-extract', async () => {
    // A row recovered by the backfill must settle as 'ok', otherwise the
    // anchor_status != 'ok' retry predicate would re-fetch it on every run forever.
    const a = await insertAction({ anchorStatus: 'fetch-failed', metaVersion: 0, title: null });
    await updateActionMetadata(db(), a.id, {
      title: 'Recovered', abstract: 'abs', rationaleHtml: '<p>r</p>', authors: null, metaVersion: 1,
    });
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.anchorStatus).toBe('ok');
    expect(got!.title).toBe('Recovered');
  });

  it('allows null metadata fields (legitimately empty anchor doc)', async () => {
    const a = await insertAction({ metaVersion: 0 });
    await updateActionMetadata(db(), a.id, {
      title: null,
      abstract: null,
      rationaleHtml: null,
      authors: null,
      metaVersion: 1,
    });
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.title).toBeNull();
    expect(got!.abstract).toBeNull();
    expect(got!.rationaleHtml).toBeNull();
    expect(got!.metaVersion).toBe(1);
  });

  it('stores and reads back author names as a JSON array', async () => {
    const a = await insertAction({ authors: null });
    await updateActionMetadata(db(), a.id, {
      title: 'T',
      abstract: 'A',
      rationaleHtml: null,
      authors: ['Mike Hornan', 'HOSKY'],
      metaVersion: 4,
    });
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.authors).toEqual(['Mike Hornan', 'HOSKY']);
  });

  it('reads authors back as null when none were stored', async () => {
    const a = await insertAction({ authors: null });
    await updateActionMetadata(db(), a.id, {
      title: 'T',
      abstract: null,
      rationaleHtml: null,
      authors: null,
      metaVersion: 4,
    });
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.authors).toBeNull();
  });

  it('reads authors written by the insert path', async () => {
    const a = await insertAction({ authors: ['Lantr Engineering', 'FluidTokens'] });
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.authors).toEqual(['Lantr Engineering', 'FluidTokens']);
  });

  it('clamps a stored authors array to 10 on read, even if the row somehow has more', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `Author ${i}`);
    const a = await insertAction({ authors: twelve });
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.authors).toHaveLength(10);
    expect(got!.authors).toEqual(twelve.slice(0, 10));
  });

  it('drops an empty string name on read and keeps the rest', async () => {
    const a = await insertAction({ authors: ['', 'Real Name'] });
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.authors).toEqual(['Real Name']);
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

  it('new: same epoch orders by exact submitted_at (newest first), NULL last', async () => {
    // Real data is consistent (higher epoch => later block_time); the interesting
    // case is two actions in the SAME epoch, where submitted_epoch ties and only
    // submitted_at distinguishes them. topic_id ascending would order them
    // 'early' < 'late', the opposite of newest-first, so this fails on the old
    // submitted_epoch-then-topic_id order.
    await seedGovRow({ topicId: 't-e500-early', actionId: 'a1', submittedEpoch: 500, submittedAt: 1000 });
    await seedGovRow({ topicId: 't-e500-late', actionId: 'a2', submittedEpoch: 500, submittedAt: 2000 });
    await seedGovRow({ topicId: 't-e501', actionId: 'a3', submittedEpoch: 501, submittedAt: 3000 });
    // Not yet backfilled: falls back to submitted_epoch order and sorts after the
    // same-epoch dated rows.
    await seedGovRow({ topicId: 't-e500-nullat', actionId: 'a4', submittedEpoch: 500, submittedAt: null });

    const { topicIds } = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'new', limit: 100, offset: 0 });
    expect(topicIds).toEqual(['t-e501', 't-e500-late', 't-e500-early', 't-e500-nullat']);
  });

  it('old: oldest submitted epoch first (reverse of new), NULL epochs last, all statuses', async () => {
    await seedGovRow({ topicId: 't-300', actionId: 'a1', submittedEpoch: 300, status: 'enacted' });
    await seedGovRow({ topicId: 't-320', actionId: 'a2', submittedEpoch: 320 });
    await seedGovRow({ topicId: 't-310', actionId: 'a3', submittedEpoch: 310, status: 'expired' });
    await seedGovRow({ topicId: 't-nil', actionId: 'a4', submittedEpoch: null });

    const { topicIds } = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'old', limit: 100, offset: 0 });
    expect(topicIds).toEqual(['t-300', 't-310', 't-320', 't-nil']);
  });

  it('closing: open first (soonest expiry), decided sink to the bottom, not hidden', async () => {
    await seedGovRow({ topicId: 't-far', actionId: 'a1', status: 'active', expiryEpoch: 400 });
    await seedGovRow({ topicId: 't-soon', actionId: 'a2', status: 'active', expiryEpoch: 360 });
    await seedGovRow({ topicId: 't-noexp', actionId: 'a3', status: 'pending', expiryEpoch: null });
    await seedGovRow({ topicId: 't-enacted', actionId: 'a4', status: 'enacted', expiryEpoch: 350 });
    await seedGovRow({ topicId: 't-expired', actionId: 'a5', status: 'expired', expiryEpoch: 355 });

    const { topicIds, total } = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'closing', limit: 100, offset: 0 });
    // Open (0) before terminal (1); within open, soonest expiry first then null last;
    // within terminal, expiry asc. Decided are included now, just at the bottom.
    expect(topicIds).toEqual(['t-soon', 't-far', 't-noexp', 't-enacted', 't-expired']);
    expect(total).toBe(5);
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

  it('type filter: restricts the page and the count to the given type', async () => {
    await seedGovRow({ topicId: 't-info1', actionId: 'i1', type: 'InfoAction', trendingScore: 30 });
    await seedGovRow({ topicId: 't-info2', actionId: 'i2', type: 'InfoAction', trendingScore: 20 });
    await seedGovRow({ topicId: 't-tw', actionId: 'w1', type: 'TreasuryWithdrawals', trendingScore: 99 });

    const filtered = await getGovernanceActionTopicIdsPage(db(), {
      categorySlug: GOV,
      sort: 'trending',
      limit: 100,
      offset: 0,
      type: 'InfoAction',
    });
    expect(filtered.topicIds).toEqual(['t-info1', 't-info2']);
    expect(filtered.total).toBe(2);

    const all = await getGovernanceActionTopicIdsPage(db(), {
      categorySlug: GOV,
      sort: 'trending',
      limit: 100,
      offset: 0,
    });
    expect(all.total).toBe(3);
  });

  it('type filter composes with closing; status=open reproduces the open-only view', async () => {
    await seedGovRow({ topicId: 't-open', actionId: 'o1', type: 'InfoAction', status: 'active', expiryEpoch: 360 });
    await seedGovRow({ topicId: 't-done', actionId: 'd1', type: 'InfoAction', status: 'enacted', expiryEpoch: 350 });
    await seedGovRow({ topicId: 't-tw', actionId: 'w1', type: 'TreasuryWithdrawals', status: 'active', expiryEpoch: 300 });

    // Default status=all: both InfoActions, open first then decided.
    const all = await getGovernanceActionTopicIdsPage(db(), {
      categorySlug: GOV, sort: 'closing', limit: 100, offset: 0, type: 'InfoAction',
    });
    expect(all.topicIds).toEqual(['t-open', 't-done']);
    expect(all.total).toBe(2);

    // status=open narrows to just the open InfoAction (old Closing-Soon behavior).
    const open = await getGovernanceActionTopicIdsPage(db(), {
      categorySlug: GOV, sort: 'closing', status: 'open', limit: 100, offset: 0, type: 'InfoAction',
    });
    expect(open.topicIds).toEqual(['t-open']);
    expect(open.total).toBe(1);
  });

  it('status=open and status=decided narrow the list and the count on both queries', async () => {
    await seedGovRow({ topicId: 't-act', actionId: 's1', status: 'active' });
    await seedGovRow({ topicId: 't-pend', actionId: 's2', status: 'pending' });
    await seedGovRow({ topicId: 't-en', actionId: 's3', status: 'enacted', decidedEpoch: 500 });
    await seedGovRow({ topicId: 't-exp', actionId: 's4', status: 'expired', decidedEpoch: 501 });

    const open = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'new', status: 'open', limit: 100, offset: 0 });
    expect(open.topicIds.slice().sort()).toEqual(['t-act', 't-pend']);
    expect(open.total).toBe(2);

    const decided = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'new', status: 'decided', limit: 100, offset: 0 });
    expect(decided.topicIds.slice().sort()).toEqual(['t-en', 't-exp']);
    expect(decided.total).toBe(2);

    const all = await getGovernanceActionTopicIdsPage(db(), { categorySlug: GOV, sort: 'new', status: 'all', limit: 100, offset: 0 });
    expect(all.total).toBe(4);
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

describe('getActionsNeedingVoteBackfill + markVotesSynced', () => {
  async function insertAction(id: string, status: string, proposalId: string | null) {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES (?, 'InfoAction', ?, ?, NULL, 0, 0)`,
    ).bind(id, status, proposalId).run();
  }

  it('returns finalised actions with a proposal id and no votes_synced_at, then excludes after marking', async () => {
    await insertAction('fin1', 'enacted', 'prop1');   // candidate
    await insertAction('act1', 'active', 'prop2');     // excluded: not finalised
    await insertAction('fin2', 'expired', null);       // excluded: no proposal id

    let c = await getActionsNeedingVoteBackfill(env.DB, 10);
    expect(c.map((a) => a.id)).toEqual(['fin1']);

    await markVotesSynced(env.DB, 'fin1', 12345);
    c = await getActionsNeedingVoteBackfill(env.DB, 10);
    expect(c).toEqual([]);
  });
});

describe('onchain_payload', () => {
  it('persists and reads back onchain_payload', async () => {
    const a = await insertAction({ onchainPayload: '{"tag":"ParameterChange"}' });
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got?.onchainPayload).toBe('{"tag":"ParameterChange"}');
  });

  it('defaults onchain_payload to null when not provided', async () => {
    const a = await insertAction();
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got?.onchainPayload).toBeNull();
  });

  it('backfills onchain_payload only where missing', async () => {
    const withPayload = await insertAction({ onchainPayload: '{"tag":"InfoAction"}' });
    const without = await insertAction();
    const missing = await getActionIdsMissingOnchainPayload(db());
    expect(missing.has(without.id)).toBe(true);
    expect(missing.has(withPayload.id)).toBe(false);

    await updateActionOnchainPayload(db(), without.id, '{"tag":"InfoAction"}');
    const after = await getActionIdsMissingOnchainPayload(db());
    expect(after.has(without.id)).toBe(false);
  });
});

describe('getLatestActionWithVotes', () => {
  // Seeds `n` distinct votes of the given role on one action.
  async function seedVotes(gaId: string, n: number, role = 'DRep'): Promise<void> {
    for (let i = 0; i < n; i++) {
      await db()
        .prepare(
          `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at)
           VALUES (?, ?, ?, 'Yes', 1)`,
        )
        .bind(gaId, role, `${gaId}-${role}-${i}`)
        .run();
    }
  }

  it('returns the newest action that has at least minVoters DRep votes', async () => {
    // Older action, clears the threshold.
    await seedGovRow({ topicId: 't-old', actionId: 'a-old', submittedAt: 1000, title: 'Old action' });
    await seedVotes('a-old', 6);
    // Newer action, one vote short of the threshold.
    await seedGovRow({ topicId: 't-new', actionId: 'a-new', submittedAt: 2000, title: 'New action' });
    await seedVotes('a-new', 5);

    const res = await getLatestActionWithVotes(db(), { minVoters: 6 });
    expect(res?.action.id).toBe('a-old');
    expect(res?.slug).toBe('slug-t-old');
  });

  it('counts only DRep votes, ignoring SPO and CC', async () => {
    await seedGovRow({ topicId: 't-spo', actionId: 'a-spo', submittedAt: 3000, title: 'SPO and CC only' });
    await seedVotes('a-spo', 6, 'SPO');
    await seedVotes('a-spo', 6, 'ConstitutionalCommittee');

    const res = await getLatestActionWithVotes(db(), { minVoters: 6 });
    expect(res).toBeNull();
  });

  it('skips deleted topics', async () => {
    await seedGovRow({ topicId: 't-del', actionId: 'a-del', submittedAt: 4000, deleted: 1, title: 'Deleted topic' });
    await seedVotes('a-del', 6);

    const res = await getLatestActionWithVotes(db(), { minVoters: 6 });
    expect(res).toBeNull();
  });

  it('skips untitled actions', async () => {
    // No title passed: seedGovRow leaves the action title null.
    await seedGovRow({ topicId: 't-untitled', actionId: 'a-untitled', submittedAt: 4500 });
    await seedVotes('a-untitled', 6);

    const res = await getLatestActionWithVotes(db(), { minVoters: 6 });
    expect(res).toBeNull();
  });

  it('returns null when no action reaches the threshold', async () => {
    await seedGovRow({ topicId: 't-few', actionId: 'a-few', submittedAt: 5000, title: 'Few votes' });
    await seedVotes('a-few', 2);

    const res = await getLatestActionWithVotes(db(), { minVoters: 6 });
    expect(res).toBeNull();
  });
});

describe('threshold snapshot backfill queries', () => {
  async function ins(id: string, type: string, status: string, thresholdsJson: string | null): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, anchor_status, status, trending_score, thresholds_json, topic_id, created_at, last_synced_at)
       VALUES (?, ?, 'no-anchor', ?, 0, ?, ?, 0, 0)`,
    )
      .bind(id, type, status, thresholdsJson, `t-${id}`)
      .run();
  }

  it('selects terminal non-Info actions whose snapshot is missing or predates the version', async () => {
    await ins('tsq-null', 'TreasuryWithdrawals', 'enacted', null);
    await ins('tsq-v1', 'HardForkInitiation', 'expired', '{"drep":67,"cc":66.67}');
    await ins('tsq-v2', 'TreasuryWithdrawals', 'enacted', `{"drep":67,"v":${THRESHOLD_SNAPSHOT_VERSION}}`);
    await ins('tsq-active', 'TreasuryWithdrawals', 'active', null);
    await ins('tsq-info', 'InfoAction', 'closed', null);

    const ids = (await getActionsNeedingThresholdSnapshot(env.DB, THRESHOLD_SNAPSHOT_VERSION, 50)).map((r) => r.id);
    expect(ids).toContain('tsq-null');
    expect(ids).toContain('tsq-v1');
    expect(ids).not.toContain('tsq-v2');
    expect(ids).not.toContain('tsq-active');
    expect(ids).not.toContain('tsq-info');
  });

  it('updateThresholdSnapshot writes the json + epoch and clears it from the candidate set', async () => {
    await ins('tsq-upd', 'TreasuryWithdrawals', 'enacted', null);
    await updateThresholdSnapshot(env.DB, {
      id: 'tsq-upd',
      thresholdsJson: `{"drep":67,"spo":null,"cc":66.67,"ccBelowMinSize":true,"v":${THRESHOLD_SNAPSHOT_VERSION}}`,
      thresholdsEpoch: 555,
    });
    const row = await env.DB.prepare('SELECT thresholds_json, thresholds_epoch FROM governance_actions WHERE id = ?')
      .bind('tsq-upd')
      .first<{ thresholds_json: string; thresholds_epoch: number }>();
    expect(JSON.parse(row!.thresholds_json).ccBelowMinSize).toBe(true);
    expect(row!.thresholds_epoch).toBe(555);
    const ids = (await getActionsNeedingThresholdSnapshot(env.DB, THRESHOLD_SNAPSHOT_VERSION, 50)).map((r) => r.id);
    expect(ids).not.toContain('tsq-upd');
  });
});

describe('getCompareCandidates', () => {
  async function seedCompareFixtures(): Promise<void> {
    await seedGovRow({ topicId: 'self', actionId: 'self#0', type: 'TreasuryWithdrawals', status: 'enacted', submittedEpoch: 650, decidedEpoch: 655, drepYesPct: 51 });
    await seedVote('self#0');
    // Eligible, same type.
    await seedGovRow({ topicId: 'same', actionId: 'same#0', type: 'TreasuryWithdrawals', status: 'enacted', submittedEpoch: 600, decidedEpoch: 607, title: 'Same type', drepYesPct: 78 });
    await seedVote('same#0');
    // Eligible, other type, newer. Must still sort below the same-type one.
    await seedGovRow({ topicId: 'other', actionId: 'other#0', type: 'InfoAction', status: 'closed', submittedEpoch: 640, decidedEpoch: 647, title: 'Other type', drepYesPct: 62 });
    await seedVote('other#0');
    // Eligible on CC votes alone: CC never carries voted_power, so a DRep-shaped
    // gate would wrongly exclude it.
    await seedGovRow({ topicId: 'cconly', actionId: 'cconly#0', type: 'TreasuryWithdrawals', status: 'expired', submittedEpoch: 610, decidedEpoch: 617, title: 'CC only', ccYesPct: 100 });
    await seedVote('cconly#0', { role: 'ConstitutionalCommittee', votedPower: null });
    // Not eligible: still open.
    await seedGovRow({ topicId: 'active', actionId: 'active#0', type: 'TreasuryWithdrawals', status: 'active', submittedEpoch: 645, decidedEpoch: null, drepYesPct: 40 });
    await seedVote('active#0');
    // Not eligible: terminal, but the only DRep row has no backfilled power.
    await seedGovRow({ topicId: 'nopower', actionId: 'nopower#0', type: 'TreasuryWithdrawals', status: 'enacted', submittedEpoch: 620, decidedEpoch: 627, drepYesPct: 55 });
    await seedVote('nopower#0', { votedPower: null });
    // Not eligible: the only row is a failed local vote.
    await seedGovRow({ topicId: 'failed', actionId: 'failed#0', type: 'TreasuryWithdrawals', status: 'enacted', submittedEpoch: 618, decidedEpoch: 625, drepYesPct: 55 });
    await seedVote('failed#0', { localStatus: 'failed' });
    // Not eligible: the only row has no block_time, so it cannot be placed on the axis.
    await seedGovRow({ topicId: 'notime', actionId: 'notime#0', type: 'TreasuryWithdrawals', status: 'enacted', submittedEpoch: 616, decidedEpoch: 623, drepYesPct: 55 });
    await seedVote('notime#0', { blockTime: null });
    // Not eligible: nobody voted Yes, so the trend has no rising support to draw.
    await seedGovRow({ topicId: 'noyes', actionId: 'noyes#0', type: 'TreasuryWithdrawals', status: 'expired', submittedEpoch: 614, decidedEpoch: 621, drepYesPct: 0 });
    await seedVote('noyes#0', { vote: 'No' });
    // Not eligible: real votes, but no stored final pct for any body, so every body
    // would be dropped and the overlay would come out empty.
    await seedGovRow({ topicId: 'nopct', actionId: 'nopct#0', type: 'TreasuryWithdrawals', status: 'enacted', submittedEpoch: 612, decidedEpoch: 619 });
    await seedVote('nopct#0');
    // Not eligible: deleted topic.
    await seedGovRow({ topicId: 'gone', actionId: 'gone#0', type: 'TreasuryWithdrawals', status: 'enacted', submittedEpoch: 630, decidedEpoch: 637, deleted: 1, drepYesPct: 55 });
    await seedVote('gone#0');
  }

  it('lists same-type candidates before other types, newest first within each group', async () => {
    await seedCompareFixtures();
    const rows = await getCompareCandidates(db(), { excludeId: 'self#0', type: 'TreasuryWithdrawals', limit: 6 });
    expect(rows.map((r) => r.id)).toEqual(['cconly#0', 'same#0', 'other#0']);
  });

  it('never offers the action being viewed', async () => {
    await seedCompareFixtures();
    const rows = await getCompareCandidates(db(), { excludeId: 'self#0', type: 'TreasuryWithdrawals', limit: 6 });
    expect(rows.some((r) => r.id === 'self#0')).toBe(false);
  });

  it('skips open actions, unusable vote rows, and deleted topics', async () => {
    await seedCompareFixtures();
    const ids = (await getCompareCandidates(db(), { excludeId: 'self#0', type: 'TreasuryWithdrawals', limit: 6 })).map((r) => r.id);
    expect(ids).not.toContain('active#0');
    expect(ids).not.toContain('nopower#0');
    expect(ids).not.toContain('failed#0');
    expect(ids).not.toContain('notime#0');
    expect(ids).not.toContain('gone#0');
  });

  // The picker is a curated list, so an entry that renders nothing on click is a
  // dead end. Both of these pass every other half of the gate.
  it('skips an action whose only vote is a No', async () => {
    await seedCompareFixtures();
    const ids = (await getCompareCandidates(db(), { excludeId: 'self#0', type: 'TreasuryWithdrawals', limit: 20 })).map((r) => r.id);
    expect(ids).not.toContain('noyes#0');
  });

  it('skips an action with votes but no stored final pct on any body', async () => {
    await seedCompareFixtures();
    const ids = (await getCompareCandidates(db(), { excludeId: 'self#0', type: 'TreasuryWithdrawals', limit: 20 })).map((r) => r.id);
    expect(ids).not.toContain('nopct#0');
  });

  it('admits an action whose only votes are CC votes', async () => {
    await seedCompareFixtures();
    const ids = (await getCompareCandidates(db(), { excludeId: 'self#0', type: 'TreasuryWithdrawals', limit: 6 })).map((r) => r.id);
    expect(ids).toContain('cconly#0');
  });

  it('honours the limit', async () => {
    await seedCompareFixtures();
    const rows = await getCompareCandidates(db(), { excludeId: 'self#0', type: 'TreasuryWithdrawals', limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('cconly#0');
  });

  it('returns the topic slug the picker links to', async () => {
    await seedCompareFixtures();
    const rows = await getCompareCandidates(db(), { excludeId: 'self#0', type: 'TreasuryWithdrawals', limit: 6 });
    expect(rows.map((r) => r.topic_slug)).toContain('slug-same');
  });
});

describe('getCompareActionBySlug', () => {
  it('returns the action with camelCase epoch and pct fields', async () => {
    await seedGovRow({ topicId: 'same', actionId: 'same#0', type: 'TreasuryWithdrawals', status: 'enacted', submittedEpoch: 600, expiryEpoch: 606, decidedEpoch: 607, title: 'Same type', drepYesPct: 78 });
    await seedVote('same#0');
    const a = await getCompareActionBySlug(db(), 'slug-same');
    expect(a?.id).toBe('same#0');
    expect(a?.topicSlug).toBe('slug-same');
    expect(a?.submittedEpoch).toBe(600);
    expect(a?.expiryEpoch).toBe(606);
    expect(a?.decidedEpoch).toBe(607);
    expect(a?.drepYesPct).toBe(78);
  });

  it('returns null for an unknown slug', async () => {
    expect(await getCompareActionBySlug(db(), 'slug-does-not-exist')).toBeNull();
  });

  it('returns null for a deleted topic', async () => {
    await seedGovRow({ topicId: 'gone', actionId: 'gone#0', status: 'enacted', decidedEpoch: 637, deleted: 1, drepYesPct: 55 });
    await seedVote('gone#0');
    expect(await getCompareActionBySlug(db(), 'slug-gone')).toBeNull();
  });

  // These three are the reason the resolver shares the picker's SQL. A hand-typed
  // ?compare= must not reach what the picker refuses to list.
  it('returns null for an action that is still open', async () => {
    await seedGovRow({ topicId: 'active', actionId: 'active#0', status: 'active', submittedEpoch: 645, decidedEpoch: null, drepYesPct: 40 });
    await seedVote('active#0');
    expect(await getCompareActionBySlug(db(), 'slug-active')).toBeNull();
  });

  it('returns null for a terminal action with no drawable votes', async () => {
    await seedGovRow({ topicId: 'nopower', actionId: 'nopower#0', status: 'enacted', submittedEpoch: 620, decidedEpoch: 627, drepYesPct: 55 });
    await seedVote('nopower#0', { votedPower: null });
    expect(await getCompareActionBySlug(db(), 'slug-nopower')).toBeNull();
  });

  it('returns null when the only vote row is a failed local vote', async () => {
    await seedGovRow({ topicId: 'failed', actionId: 'failed#0', status: 'enacted', submittedEpoch: 618, decidedEpoch: 625, drepYesPct: 55 });
    await seedVote('failed#0', { localStatus: 'failed' });
    expect(await getCompareActionBySlug(db(), 'slug-failed')).toBeNull();
  });

  it('returns null for an action whose only vote is a No', async () => {
    await seedGovRow({ topicId: 'noyes', actionId: 'noyes#0', status: 'expired', submittedEpoch: 614, decidedEpoch: 621, drepYesPct: 0 });
    await seedVote('noyes#0', { vote: 'No' });
    expect(await getCompareActionBySlug(db(), 'slug-noyes')).toBeNull();
  });

  it('returns null for an action with votes but no stored final pct on any body', async () => {
    await seedGovRow({ topicId: 'nopct', actionId: 'nopct#0', status: 'enacted', submittedEpoch: 612, decidedEpoch: 619 });
    await seedVote('nopct#0');
    expect(await getCompareActionBySlug(db(), 'slug-nopct')).toBeNull();
  });
});
