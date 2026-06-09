import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncGovernanceActions, backfillActionMetadata, backfillGovTopicSubmittedAt } from './sync.js';
import { META_EXTRACT_VERSION } from './metadata.js';
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
});
