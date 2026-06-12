import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncGovernanceActions, backfillActionMetadata, backfillGovTopicSubmittedAt, refreshTrendingScores } from './sync.js';
import { META_EXTRACT_VERSION, META_REEXTRACT_MAX_ATTEMPTS } from './metadata.js';
import { buildInsertGovernanceAction, getGovernanceActionByTopicId } from '../db/governance.js';
import type { ProposalListRow } from '../koios/client.js';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';

const anchorDoc = {
  body: { title: 'Fund Community Tooling', abstract: 'A treasury withdrawal for tooling.', rationale: 'Rationale.' },
};
const anchorJson = JSON.stringify(anchorDoc);
const anchorHash = bytesToHex(blake2b256(new TextEncoder().encode(anchorJson)));
const fetchOk: typeof fetch = async () =>
  new Response(anchorJson, { headers: { 'content-type': 'application/json' } });

const proposals: ProposalListRow[] = [
  {
    proposal_id: 'gov_action1abc',
    proposal_tx_hash: 'aa'.repeat(32),
    proposal_index: 0,
    proposal_type: 'TreasuryWithdrawals',
    deposit: '100000000000',
    return_address: 'stake_test1xyz',
    proposed_epoch: 200,
    expiration: 230,
    meta_url: 'https://example.com/m.json',
    meta_hash: anchorHash,
  },
  {
    proposal_id: 'gov_action1def',
    proposal_tx_hash: 'bb'.repeat(32),
    proposal_index: 1,
    proposal_type: 'InfoAction',
    deposit: null,
    return_address: null,
    proposed_epoch: 201,
    expiration: null,
    meta_url: null,
    meta_hash: null,
  },
];

function fakeKoios(rows: ProposalListRow[]) {
  return { proposalList: async () => rows };
}

describe('syncGovernanceActions', () => {
  it('creates a thread + governance_actions row per new action, then is idempotent', async () => {
    let n = 0;
    const rand = () => `r${n++}`;

    const r1 = await syncGovernanceActions({
      koios: fakeKoios(proposals),
      db: env.DB,
      network: 'preprod',
      now: 1_700_000_000_000,
      rand,
      fetchImpl: fetchOk,
    });
    expect(r1).toMatchObject({ total: 2, created: 2, skipped: 0, failed: 0 });

    const topics = (
      await env.DB.prepare(
        "SELECT title, source, author_id FROM topics WHERE category_slug = 'governance-actions'",
      ).all<{ title: string; source: string; author_id: string }>()
    ).results;
    expect(topics.length).toBe(2);
    const anchored = topics.find((t) => t.title === 'Fund Community Tooling');
    expect(anchored).toBeTruthy();
    expect(anchored!.source).toBe('governance');
    expect(anchored!.author_id).toBe('gov-sync');
    // Action with no anchor gets a generated title from its type + tx hash.
    expect(topics.some((t) => t.title.startsWith('Info Action ('))).toBe(true);

    const gas = (
      await env.DB.prepare('SELECT id, type, anchor_status, topic_id FROM governance_actions').all<{
        id: string;
        type: string;
        anchor_status: string;
        topic_id: string;
      }>()
    ).results;
    expect(gas.length).toBe(2);
    const withAnchor = gas.find((g) => g.id === `${'aa'.repeat(32)}#0`);
    expect(withAnchor!.anchor_status).toBe('ok');
    expect(withAnchor!.topic_id).toBeTruthy();

    // Re-run: nothing new.
    const r2 = await syncGovernanceActions({
      koios: fakeKoios(proposals),
      db: env.DB,
      network: 'preprod',
      now: 1_700_000_100_000,
      rand,
      fetchImpl: fetchOk,
    });
    expect(r2).toMatchObject({ total: 2, created: 0, skipped: 2, failed: 0 });
  });

  it('stores META_EXTRACT_VERSION on newly discovered actions', async () => {
    let n = 100;
    const rand = () => `rv${n++}`;
    await syncGovernanceActions({
      koios: fakeKoios([proposals[0]]),
      db: env.DB,
      network: 'preprod',
      now: 1_700_000_200_000,
      rand,
      fetchImpl: fetchOk,
    });
    const row = await env.DB
      .prepare('SELECT meta_version FROM governance_actions WHERE id = ?')
      .bind(`${'aa'.repeat(32)}#0`)
      .first<{ meta_version: number }>();
    // Row may already exist from the previous test; either way meta_version must
    // be META_EXTRACT_VERSION (1) because discovery always writes the current version.
    expect(row?.meta_version).toBe(META_EXTRACT_VERSION);
  });
});

// CIP-108 anchor doc with Markdown rationale for the backfill tests.
const backfillDoc = {
  body: {
    title: 'Backfill Action',
    abstract: 'Abstract line one.\nAbstract line two.',
    rationale: '## Rationale\n\nThis is a paragraph.\n\nAnother paragraph.',
  },
};
const backfillJson = JSON.stringify(backfillDoc);
const backfillHash = bytesToHex(blake2b256(new TextEncoder().encode(backfillJson)));

const NOW_BF = 1_755_000_000_000;
let bfSeq = 0;

// Insert a stale governance action (meta_version 0) with a valid anchor.
async function insertStaleAction(anchorUrl: string, anchorHash: string) {
  bfSeq++;
  const id = `bftx${bfSeq}#0`;
  const topicId = `bf-topic-${bfSeq}`;
  await env.DB.batch([
    buildInsertGovernanceAction(env.DB, {
      id,
      proposalId: `bf_gov_action_${bfSeq}`,
      type: 'TreasuryWithdrawals',
      title: 'Old title',
      abstract: 'Old abstract',
      rationaleHtml: '<p>Old rationale</p>',
      anchorUrl,
      anchorHash,
      anchorStatus: 'ok',
      returnAddress: 'stake_test_bf',
      deposit: '200000000000',
      submittedEpoch: 300,
      expiryEpoch: 310,
      metaVersion: 0,
      topicId,
      now: NOW_BF,
    }),
  ]);
  return { id, topicId };
}

describe('backfillActionMetadata', () => {
  it('re-extracts via fetchImpl, writes updated metadata, and bumps meta_version', async () => {
    const { id, topicId } = await insertStaleAction('https://example.com/backfill.json', backfillHash);

    const fetchImpl: typeof fetch = async () =>
      new Response(backfillJson, { headers: { 'content-type': 'application/json' } });

    const result = await backfillActionMetadata({ db: env.DB, now: NOW_BF + 1, fetchImpl, limit: 10 });
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const got = await getGovernanceActionByTopicId(env.DB, topicId);
    expect(got).not.toBeNull();
    // meta_version bumped to the current extractor version.
    expect(got!.metaVersion).toBe(META_EXTRACT_VERSION);
    // Rationale is now rendered Markdown: must contain paragraph and heading tags.
    expect(got!.rationaleHtml).toContain('<p>');
    expect(got!.rationaleHtml).toContain('<h2>');
    // Abstract and title re-extracted correctly.
    expect(got!.title).toBe('Backfill Action');
    // The anchor status is a separate column and must be untouched.
    expect(got!.anchorStatus).toBe('ok');
    // Status (pending) must not have changed.
    expect(got!.status).toBe('pending');
    // Row id must not have changed.
    expect(got!.id).toBe(id);
  });

  it('does not bump meta_version when the fetch fails, and counts as failed', async () => {
    const { topicId } = await insertStaleAction('https://example.com/fail.json', backfillHash);

    const fetchFail: typeof fetch = async () => { throw new Error('network error'); };

    const result = await backfillActionMetadata({ db: env.DB, now: NOW_BF + 2, fetchImpl: fetchFail, limit: 10 });
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const got = await getGovernanceActionByTopicId(env.DB, topicId);
    // meta_version must remain 0: fetch failed, do not mark as current.
    expect(got!.metaVersion).toBe(0);
  });

  it('does not bump meta_version when the anchor hash mismatches', async () => {
    const wrongHash = 'ff'.repeat(32);
    const { topicId } = await insertStaleAction('https://example.com/mismatch.json', wrongHash);

    const fetchImpl: typeof fetch = async () =>
      new Response(backfillJson, { headers: { 'content-type': 'application/json' } });

    const result = await backfillActionMetadata({ db: env.DB, now: NOW_BF + 3, fetchImpl, limit: 10 });
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const got = await getGovernanceActionByTopicId(env.DB, topicId);
    expect(got!.metaVersion).toBe(0);
  });

  it('bumps meta_version even when the doc has no rationale (empty but valid)', async () => {
    const emptyDoc = { body: { title: 'No Rationale', abstract: '', rationale: '' } };
    const emptyJson = JSON.stringify(emptyDoc);
    const emptyHash = bytesToHex(blake2b256(new TextEncoder().encode(emptyJson)));
    const { topicId } = await insertStaleAction('https://example.com/empty.json', emptyHash);

    const fetchImpl: typeof fetch = async () =>
      new Response(emptyJson, { headers: { 'content-type': 'application/json' } });

    const result = await backfillActionMetadata({ db: env.DB, now: NOW_BF + 4, fetchImpl, limit: 10 });
    expect(result.failed).toBe(0);

    const got = await getGovernanceActionByTopicId(env.DB, topicId);
    // Successful fetch: version must be bumped even though rationale is null.
    expect(got!.metaVersion).toBe(META_EXTRACT_VERSION);
    expect(got!.rationaleHtml).toBeNull();
  });

  it('respects the limit parameter', async () => {
    await insertStaleAction('https://example.com/lim1.json', backfillHash);
    await insertStaleAction('https://example.com/lim2.json', backfillHash);
    const fetchImpl: typeof fetch = async () =>
      new Response(backfillJson, { headers: { 'content-type': 'application/json' } });

    const result = await backfillActionMetadata({ db: env.DB, now: NOW_BF + 5, fetchImpl, limit: 1 });
    expect(result.scanned).toBe(1);
  });

  it('increments meta_attempts on a failed fetch and resets it on a later success', async () => {
    const { id, topicId } = await insertStaleAction('https://example.com/attempts.json', backfillHash);

    const fetchFail: typeof fetch = async () => { throw new Error('network error'); };
    await backfillActionMetadata({ db: env.DB, now: NOW_BF + 8, fetchImpl: fetchFail, limit: 10 });
    await backfillActionMetadata({ db: env.DB, now: NOW_BF + 9, fetchImpl: fetchFail, limit: 10 });

    const afterFail = await env.DB.prepare('SELECT meta_attempts FROM governance_actions WHERE id = ?')
      .bind(id).first<{ meta_attempts: number }>();
    expect(afterFail!.meta_attempts).toBe(2);

    // A successful extract bumps the version and clears the attempt counter.
    const fetchImpl: typeof fetch = async () =>
      new Response(backfillJson, { headers: { 'content-type': 'application/json' } });
    await backfillActionMetadata({ db: env.DB, now: NOW_BF + 10, fetchImpl, limit: 10 });

    const got = await getGovernanceActionByTopicId(env.DB, topicId);
    expect(got!.metaVersion).toBe(META_EXTRACT_VERSION);
    const afterOk = await env.DB.prepare('SELECT meta_attempts FROM governance_actions WHERE id = ?')
      .bind(id).first<{ meta_attempts: number }>();
    expect(afterOk!.meta_attempts).toBe(0);
  });

  it('gives up on a permanently dead anchor once meta_attempts hits the cap', async () => {
    const { id } = await insertStaleAction('https://example.com/permadead.json', backfillHash);
    // Simulate a row that has already exhausted its retry budget.
    await env.DB.prepare('UPDATE governance_actions SET meta_attempts = ? WHERE id = ?')
      .bind(META_REEXTRACT_MAX_ATTEMPTS, id).run();

    const fetchFail: typeof fetch = async () => { throw new Error('still dead'); };
    const result = await backfillActionMetadata({ db: env.DB, now: NOW_BF + 11, fetchImpl: fetchFail, limit: 10 });

    // The exhausted row is no longer a candidate: nothing scanned, nothing failed.
    const stillThere = await env.DB.prepare('SELECT id FROM governance_actions WHERE id = ?')
      .bind(id).first();
    expect(stillThere).not.toBeNull();
    expect(result.scanned).toBe(0);
  });

  it('scans 0 on the second run when all stale rows have been updated', async () => {
    const { topicId } = await insertStaleAction('https://example.com/second-run.json', backfillHash);
    const fetchImpl: typeof fetch = async () =>
      new Response(backfillJson, { headers: { 'content-type': 'application/json' } });

    await backfillActionMetadata({ db: env.DB, now: NOW_BF + 6, fetchImpl, limit: 10 });
    const got = await getGovernanceActionByTopicId(env.DB, topicId);
    expect(got!.metaVersion).toBe(META_EXTRACT_VERSION);

    const second = await backfillActionMetadata({ db: env.DB, now: NOW_BF + 7, fetchImpl, limit: 10 });
    // The action inserted above is now current; it must not appear in scanned.
    expect(second.scanned).toBe(0);
  });
});

describe('submission-date post stamping and backfill', () => {
  const EPOCH_200_MS = 1742169600000; // epochStartUnix(200, preprod) * 1000

  it('stamps a newly synced governance topic with the submission-epoch time', async () => {
    let n = 0;
    const rand = () => `rstamp${n++}`;
    await syncGovernanceActions({
      koios: fakeKoios([proposals[0]]), // proposed_epoch: 200
      db: env.DB,
      network: 'preprod',
      now: 1_700_000_000_000, // deliberately != the epoch-200 time
      rand,
      fetchImpl: fetchOk,
    });
    const row = await env.DB
      .prepare(
        `SELECT t.created_at AS created_at, t.last_post_at AS last_post_at
         FROM topics t JOIN governance_actions ga ON ga.topic_id = t.id
         WHERE ga.id = ?`,
      )
      .bind(`${'aa'.repeat(32)}#0`)
      .first<{ created_at: number; last_post_at: number }>();
    expect(row).toEqual({ created_at: EPOCH_200_MS, last_post_at: EPOCH_200_MS });
  });

  it('corrects a no-reply governance topic to the submission time, then is a no-op', async () => {
    const SYNC_TIME = 1_700_000_000_000;
    const topicId = 'bf-topic-1';
    const actionId = 'bf-action-1';
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at)
           VALUES (?, 'governance-actions', 'gov-sync', 'governance', 'Backfill Me', 'backfill-me-bf1', 1, ?, ?)`,
        )
        .bind(topicId, SYNC_TIME, SYNC_TIME),
      env.DB
        .prepare(
          `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at)
           VALUES ('bf-post-1', ?, 'gov-sync', 'b', '<p>b</p>', ?)`,
        )
        .bind(topicId, SYNC_TIME),
      buildInsertGovernanceAction(env.DB, {
        id: actionId,
        proposalId: 'gov_action1bf',
        type: 'InfoAction',
        title: null,
        abstract: null,
        rationaleHtml: null,
        anchorUrl: null,
        anchorHash: null,
        anchorStatus: 'no-anchor',
        returnAddress: null,
        deposit: null,
        submittedEpoch: 200,
        expiryEpoch: null,
        metaVersion: META_EXTRACT_VERSION,
        topicId,
        now: SYNC_TIME,
      }),
    ]);

    const r1 = await backfillGovTopicSubmittedAt({ db: env.DB, network: 'preprod', limit: 200 });
    expect(r1.updated).toBeGreaterThanOrEqual(1);

    const fixed = await env.DB
      .prepare(
        `SELECT t.created_at AS tc, t.last_post_at AS tl, p.created_at AS pc
         FROM topics t JOIN posts p ON p.topic_id = t.id WHERE t.id = ?`,
      )
      .bind(topicId)
      .first<{ tc: number; tl: number; pc: number }>();
    expect(fixed).toEqual({ tc: EPOCH_200_MS, tl: EPOCH_200_MS, pc: EPOCH_200_MS });

    const r2 = await backfillGovTopicSubmittedAt({ db: env.DB, network: 'preprod', limit: 200 });
    expect(r2.updated).toBe(0);
  });

  it('never touches a governance topic that has real replies', async () => {
    const SYNC_TIME = 1_700_000_000_000;
    const topicId = 'bf-topic-replied';
    await env.DB.batch([
      // post_count is the denormalized reply counter; no post rows are needed to
      // exercise the post_count <= 1 filter.
      env.DB
        .prepare(
          `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at)
           VALUES (?, 'governance-actions', 'gov-sync', 'governance', 'Has Replies', 'has-replies-bf2', 2, ?, ?)`,
        )
        .bind(topicId, SYNC_TIME, SYNC_TIME),
      buildInsertGovernanceAction(env.DB, {
        id: 'bf-action-replied',
        proposalId: 'gov_action1bf2',
        type: 'InfoAction',
        title: null,
        abstract: null,
        rationaleHtml: null,
        anchorUrl: null,
        anchorHash: null,
        anchorStatus: 'no-anchor',
        returnAddress: null,
        deposit: null,
        submittedEpoch: 200,
        expiryEpoch: null,
        metaVersion: META_EXTRACT_VERSION,
        topicId,
        now: SYNC_TIME,
      }),
    ]);

    await backfillGovTopicSubmittedAt({ db: env.DB, network: 'preprod', limit: 200 });

    const row = await env.DB
      .prepare('SELECT created_at, last_post_at FROM topics WHERE id = ?')
      .bind(topicId)
      .first<{ created_at: number; last_post_at: number }>();
    expect(row).toEqual({ created_at: SYNC_TIME, last_post_at: SYNC_TIME });
  });

  it('stamps only the system post, never a reply that raced the candidate read', async () => {
    // TOCTOU race: the candidate SELECT observed post_count <= 1, but a user reply
    // landed before the per-topic stamp ran. The stamp must touch only the
    // system/first post, leaving the reply's timestamp intact. post_count is left at
    // 1 to mimic the stale read even though two post rows already exist.
    const SYNC_TIME = 1_700_000_000_000;
    const REPLY_TIME = SYNC_TIME + 3_600_000; // one hour after the system post
    const topicId = 'bf-topic-raced';
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at)
           VALUES (?, 'governance-actions', 'gov-sync', 'governance', 'Raced', 'raced-bf3', 1, ?, ?)`,
        )
        .bind(topicId, REPLY_TIME, SYNC_TIME),
      env.DB
        .prepare(
          `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at)
           VALUES ('bf-post-sys', ?, 'gov-sync', 's', '<p>s</p>', ?)`,
        )
        .bind(topicId, SYNC_TIME),
      env.DB
        .prepare(
          `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at)
           VALUES ('bf-post-reply', ?, 'drep-user', 'r', '<p>r</p>', ?)`,
        )
        .bind(topicId, REPLY_TIME),
      buildInsertGovernanceAction(env.DB, {
        id: 'bf-action-raced',
        proposalId: 'gov_action1bf3',
        type: 'InfoAction',
        title: null,
        abstract: null,
        rationaleHtml: null,
        anchorUrl: null,
        anchorHash: null,
        anchorStatus: 'no-anchor',
        returnAddress: null,
        deposit: null,
        submittedEpoch: 200,
        expiryEpoch: null,
        metaVersion: META_EXTRACT_VERSION,
        topicId,
        now: SYNC_TIME,
      }),
    ]);

    await backfillGovTopicSubmittedAt({ db: env.DB, network: 'preprod', limit: 200 });

    const sys = await env.DB
      .prepare('SELECT created_at FROM posts WHERE id = ?')
      .bind('bf-post-sys')
      .first<{ created_at: number }>();
    const reply = await env.DB
      .prepare('SELECT created_at FROM posts WHERE id = ?')
      .bind('bf-post-reply')
      .first<{ created_at: number }>();
    // The system/first post is stamped to the submission time...
    expect(sys!.created_at).toBe(EPOCH_200_MS);
    // ...but the racing reply keeps its original timestamp.
    expect(reply!.created_at).toBe(REPLY_TIME);
  });
});

describe('refreshTrendingScores', () => {
  const GOV = 'governance-actions';
  const DAY = 86_400_000;
  const RNOW = 1_753_000_000_000;

  // Seeds a governance topic + its action (no trending_score yet).
  async function seed(topicId: string, actionId: string, o: { postCount?: number; lastPostAt?: number; deleted?: number } = {}): Promise<void> {
    const lastPostAt = o.lastPostAt ?? RNOW;
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
           VALUES (?, ?, 'gov-sync', 'governance', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(topicId, GOV, `T ${topicId}`, `slug-${topicId}`, o.postCount ?? 1, lastPostAt, lastPostAt, o.deleted ?? 0),
      buildInsertGovernanceAction(env.DB, {
        id: actionId, proposalId: null, type: 'InfoAction', title: null, abstract: null, rationaleHtml: null,
        anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor', returnAddress: null, deposit: null,
        submittedEpoch: 200, expiryEpoch: null, metaVersion: META_EXTRACT_VERSION, topicId, now: RNOW,
      }),
    ]);
  }

  const scoreOf = async (topicId: string): Promise<number | null> =>
    (await env.DB.prepare('SELECT trending_score AS s FROM governance_actions WHERE topic_id = ?').bind(topicId).first<{ s: number | null }>())?.s ?? null;

  it('scores every listed action, then is a no-op on the second run', async () => {
    await seed('t1', 'a1', { postCount: 1, lastPostAt: RNOW - 5 * DAY });
    await seed('t2', 'a2', { postCount: 4, lastPostAt: RNOW - 1 * DAY });

    const r1 = await refreshTrendingScores({ db: env.DB });
    expect(r1.scanned).toBe(2);
    expect(r1.updated).toBe(2);
    expect(await scoreOf('t1')).not.toBeNull();
    expect(await scoreOf('t2')).not.toBeNull();

    // The second run recomputes identical scores, so only-changed writes nothing. This
    // also proves the stored score equals trendingOrderKey exactly (else it would rewrite).
    const r2 = await refreshTrendingScores({ db: env.DB });
    expect(r2.scanned).toBe(2);
    expect(r2.updated).toBe(0);
  });

  it('re-scores an action after a reply bumps post_count and last_post_at', async () => {
    await seed('t1', 'a1', { postCount: 1, lastPostAt: RNOW - 10 * DAY });
    await refreshTrendingScores({ db: env.DB });
    const before = await scoreOf('t1');

    // Simulate a reply: one more post, activity moves to (almost) now.
    await env.DB.prepare('UPDATE topics SET post_count = 2, last_post_at = ? WHERE id = ?').bind(RNOW - 1 * DAY, 't1').run();

    const r = await refreshTrendingScores({ db: env.DB });
    expect(r.updated).toBe(1);
    expect(await scoreOf('t1')).toBeGreaterThan(before!);
  });

  it('skips deleted topics and actions with no topic', async () => {
    await seed('t-live', 'a-live');
    await seed('t-del', 'a-del', { deleted: 1 });
    // Action with no topic at all: getAllTopicsByCategory cannot resolve it, so it is skipped.
    await env.DB
      .prepare(
        `INSERT INTO governance_actions (id, type, anchor_status, status, topic_id, created_at, last_synced_at)
         VALUES ('a-orphan', 'InfoAction', 'no-anchor', 'active', NULL, ?, ?)`,
      )
      .bind(RNOW, RNOW)
      .run();

    const r = await refreshTrendingScores({ db: env.DB });
    expect(r.scanned).toBe(3); // every action is scanned
    expect(r.updated).toBe(1); // only the live, non-deleted, topic-backed one is scored
    expect(await scoreOf('t-live')).not.toBeNull();
    expect(await scoreOf('t-del')).toBeNull();
  });
});
