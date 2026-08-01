import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncGovernanceActions, backfillActionMetadata, backfillGovTopicSubmittedAt, backfillGovTopicTitles, refreshTrendingScores } from './sync.js';
import { META_EXTRACT_VERSION, META_REEXTRACT_MAX_ATTEMPTS } from './metadata.js';
import { buildInsertGovernanceAction, getGovernanceActionByTopicId } from '../db/governance.js';
import { activityInsert } from '../db/activity.js';
import { createTopic, getOpeningPostBody } from '../db/forum.js';
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

    // Each new governance topic emits exactly one gov_created activity event.
    const govEvents = (
      await env.DB.prepare("SELECT topic_id, type, actor_id FROM activity WHERE type = 'gov_created'").all<{
        topic_id: string;
        type: string;
        actor_id: string | null;
      }>()
    ).results;
    expect(govEvents.length).toBe(2);
    expect(govEvents.every((e) => e.actor_id === null)).toBe(true);
    // No topic_created events for governance topics.
    const topicCreated = (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE type = 'topic_created'").first<{ n: number }>()
    )!;
    expect(topicCreated.n).toBe(0);

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

  it('leaves a failed-anchor action retriable instead of stamping the current version', async () => {
    // An action with an anchor whose fetch fails at discovery must NOT be stamped at
    // the current extractor version: otherwise the metadata backfill (meta_version <
    // current) would skip it forever and the topic would keep its fallback title.
    const failProposal: ProposalListRow = {
      proposal_id: 'gov_action1fail',
      proposal_tx_hash: 'ef'.repeat(32),
      proposal_index: 0,
      proposal_type: 'TreasuryWithdrawals',
      deposit: '100000000000',
      return_address: 'stake_test1fail',
      proposed_epoch: 250,
      expiration: 260,
      meta_url: 'https://example.com/fail-meta.json',
      meta_hash: anchorHash,
    };
    const fetchFail: typeof fetch = async () => {
      throw new Error('gateway down');
    };
    let n = 500;
    await syncGovernanceActions({
      koios: fakeKoios([failProposal]),
      db: env.DB,
      network: 'preprod',
      now: 1_700_000_500_000,
      rand: () => `rf${n++}`,
      fetchImpl: fetchFail,
    });
    const row = await env.DB
      .prepare('SELECT meta_version, anchor_status FROM governance_actions WHERE id = ?')
      .bind(`${'ef'.repeat(32)}#0`)
      .first<{ meta_version: number; anchor_status: string }>();
    expect(row?.anchor_status).toBe('fetch-failed');
    expect(row!.meta_version).toBeLessThan(META_EXTRACT_VERSION);
  });

  it('stores proposal_description as onchain_payload on discovery', async () => {
    const txHash = 'cc'.repeat(32);
    const row: ProposalListRow = {
      proposal_id: 'gov_action1pay',
      proposal_tx_hash: txHash,
      proposal_index: 0,
      proposal_type: 'ParameterChange',
      meta_url: null,
      meta_hash: null,
      proposed_epoch: 1,
      expiration: 2,
      proposal_description: { tag: 'ParameterChange', contents: [null, { govActionDeposit: 1000000000 }, 'fa'] },
    };
    await syncGovernanceActions({
      koios: fakeKoios([row]),
      db: env.DB,
      network: 'preprod',
      now: 1_700_001_000_000,
      rand: () => 'rnd-pay',
      fetchImpl: fetchOk,
    });
    const stored = await env.DB
      .prepare('SELECT onchain_payload FROM governance_actions WHERE id = ?')
      .bind(`${txHash}#0`)
      .first<{ onchain_payload: string }>();
    expect(JSON.parse(stored!.onchain_payload).contents[1].govActionDeposit).toBe(1000000000);
  });

  it('backfills onchain_payload for a pre-existing row', async () => {
    const txHash = 'dd'.repeat(32);
    const id = `${txHash}#0`;
    await env.DB.batch([
      buildInsertGovernanceAction(env.DB, {
        id,
        proposalId: 'gov_action1bf',
        type: 'HardForkInitiation',
        title: null,
        abstract: null,
        rationaleHtml: null,
        anchorUrl: null,
        anchorHash: null,
        anchorStatus: 'no-anchor',
        returnAddress: null,
        deposit: null,
        submittedEpoch: 1,
        expiryEpoch: 2,
        metaVersion: META_EXTRACT_VERSION,
        topicId: 'topic-bf-ocp',
        now: 1,
      }),
    ]);
    await syncGovernanceActions({
      koios: fakeKoios([
        {
          proposal_id: 'gov_action1bf',
          proposal_tx_hash: txHash,
          proposal_index: 0,
          proposal_type: 'HardForkInitiation',
          meta_url: null,
          meta_hash: null,
          proposed_epoch: 1,
          expiration: 2,
          proposal_description: { tag: 'HardForkInitiation', contents: [null, { major: 11, minor: 0 }] },
        },
      ]),
      db: env.DB,
      network: 'preprod',
      now: 1,
      rand: () => 'rnd-bf',
      fetchImpl: fetchOk,
    });
    const stored = await env.DB
      .prepare('SELECT onchain_payload FROM governance_actions WHERE id = ?')
      .bind(id)
      .first<{ onchain_payload: string }>();
    expect(JSON.parse(stored!.onchain_payload).contents[1].major).toBe(11);
  });

  it('stores submitted_at (block_time x1000) on discovery', async () => {
    const txHash = 'ee'.repeat(32);
    await syncGovernanceActions({
      koios: fakeKoios([
        {
          proposal_id: 'gov_action1bt',
          proposal_tx_hash: txHash,
          proposal_index: 0,
          proposal_type: 'InfoAction',
          meta_url: null,
          meta_hash: null,
          proposed_epoch: 500,
          expiration: 510,
          block_time: 1_700_000_500,
        },
      ]),
      db: env.DB,
      network: 'preprod',
      now: 1_700_002_000_000,
      rand: () => 'rnd-bt',
      fetchImpl: fetchOk,
    });
    const stored = await env.DB
      .prepare('SELECT submitted_at FROM governance_actions WHERE id = ?')
      .bind(`${txHash}#0`)
      .first<{ submitted_at: number }>();
    expect(stored!.submitted_at).toBe(1_700_000_500_000);
  });

  it('backfills submitted_at for a pre-existing row from block_time', async () => {
    const txHash = 'ff'.repeat(32);
    const id = `${txHash}#0`;
    // Insert a row without submitted_at (NULL), as discovery did before this column.
    await env.DB.batch([
      buildInsertGovernanceAction(env.DB, {
        id,
        proposalId: 'gov_action1btbf',
        type: 'InfoAction',
        title: null,
        abstract: null,
        rationaleHtml: null,
        anchorUrl: null,
        anchorHash: null,
        anchorStatus: 'no-anchor',
        returnAddress: null,
        deposit: null,
        submittedEpoch: 500,
        expiryEpoch: 510,
        metaVersion: META_EXTRACT_VERSION,
        topicId: 'topic-bt-bf',
        now: 1,
      }),
    ]);
    await syncGovernanceActions({
      koios: fakeKoios([
        {
          proposal_id: 'gov_action1btbf',
          proposal_tx_hash: txHash,
          proposal_index: 0,
          proposal_type: 'InfoAction',
          meta_url: null,
          meta_hash: null,
          proposed_epoch: 500,
          expiration: 510,
          block_time: 1_700_000_900,
        },
      ]),
      db: env.DB,
      network: 'preprod',
      now: 1,
      rand: () => 'rnd-btbf',
      fetchImpl: fetchOk,
    });
    const stored = await env.DB
      .prepare('SELECT submitted_at FROM governance_actions WHERE id = ?')
      .bind(id)
      .first<{ submitted_at: number | null }>();
    expect(stored!.submitted_at).toBe(1_700_000_900_000);
  });

  it('stores author names discovered in the anchor document', async () => {
    const authoredDoc = JSON.stringify({
      body: { title: 'Community proposal', abstract: 'A', rationale: 'R' },
      authors: [{ name: 'Mike Hornan' }, { name: 'HOSKY' }],
    });
    const authoredHash = bytesToHex(blake2b256(new TextEncoder().encode(authoredDoc)));
    const proposal: ProposalListRow = {
      proposal_id: 'gov_action1authored',
      proposal_tx_hash: 'cc'.repeat(32),
      proposal_index: 0,
      proposal_type: 'InfoAction',
      deposit: null,
      return_address: 'stake_test1authored',
      proposed_epoch: 202,
      expiration: 232,
      meta_url: 'https://example.com/authored.json',
      meta_hash: authoredHash,
    };

    let n = 0;
    await syncGovernanceActions({
      koios: fakeKoios([proposal]),
      db: env.DB,
      network: 'preprod',
      now: 1_700_000_000_000,
      rand: () => `authored${n++}`,
      fetchImpl: async () => new Response(authoredDoc, { headers: { 'content-type': 'application/json' } }),
    });

    const row = await env.DB.prepare('SELECT topic_id FROM governance_actions WHERE proposal_id = ?')
      .bind('gov_action1authored')
      .first<{ topic_id: string }>();
    const got = await getGovernanceActionByTopicId(env.DB, row!.topic_id);
    expect(got!.authors).toEqual(['Mike Hornan', 'HOSKY']);
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

  it('re-fetches and recovers a failed-anchor row stamped at the current version', async () => {
    // Latent data shape: the anchor failed at discovery, so title is null, anchor_status
    // is 'fetch-failed', and meta_version was (wrongly) stamped current. The backfill must
    // still pick it up (anchor_status != 'ok') and settle it to 'ok' on a successful fetch.
    const topicId = 'recover1-topic';
    await env.DB.batch([
      buildInsertGovernanceAction(env.DB, {
        id: 'recover1#0',
        proposalId: 'gov_recover1',
        type: 'TreasuryWithdrawals',
        title: null,
        abstract: null,
        rationaleHtml: null,
        anchorUrl: 'https://example.com/recover1.json',
        anchorHash: backfillHash,
        anchorStatus: 'fetch-failed',
        returnAddress: 'stake_test_r1',
        deposit: '200000000000',
        submittedEpoch: 300,
        expiryEpoch: 310,
        metaVersion: META_EXTRACT_VERSION,
        topicId,
        now: NOW_BF,
      }),
    ]);
    const fetchImpl: typeof fetch = async () =>
      new Response(backfillJson, { headers: { 'content-type': 'application/json' } });
    await backfillActionMetadata({ db: env.DB, now: NOW_BF + 30, fetchImpl, limit: 200 });
    const got = await getGovernanceActionByTopicId(env.DB, topicId);
    expect(got!.title).toBe('Backfill Action');
    expect(got!.anchorStatus).toBe('ok');
  });

  it('backfillGovTopicTitles syncs a stale fallback topic title and re-renders the opening post', async () => {
    // A governance topic whose action carries a real title but whose topic title is still
    // the discovery-time fallback (and the opening post still says no abstract): the case
    // for both newly re-fetched anchors and older action-only recoveries.
    const { topic } = await createTopic(env.DB, {
      categorySlug: 'governance-actions',
      authorId: 'gov-sync',
      title: 'Treasury Withdrawals (cccc0000#0)',
      bodyMd: '**On-chain governance action** (Treasury Withdrawals).\n\nNo abstract was provided in the action metadata.',
      bodyHtml: '<p>No abstract was provided in the action metadata.</p>',
      source: 'governance',
      now: NOW_BF,
      postedAt: NOW_BF,
      rand: 'sweep',
    });
    await env.DB.batch([
      buildInsertGovernanceAction(env.DB, {
        id: 'cccc0000aaaa#0',
        proposalId: 'gov_sweep',
        type: 'TreasuryWithdrawals',
        title: 'Withdraw 540,750 ada for Oura by TxPipe',
        abstract: 'This Treasury Withdrawal funds Oura by TxPipe.',
        rationaleHtml: '<p>r</p>',
        anchorUrl: 'https://example.com/sweep.json',
        anchorHash: 'h',
        anchorStatus: 'ok',
        returnAddress: 'stake_test_sweep',
        deposit: '540750000000',
        submittedEpoch: 638,
        expiryEpoch: 645,
        metaVersion: META_EXTRACT_VERSION,
        topicId: topic.id,
        now: NOW_BF,
      }),
    ]);

    const r = await backfillGovTopicTitles({ db: env.DB, network: 'preprod', limit: 200 });
    expect(r.updated).toBeGreaterThanOrEqual(1);

    // The topic title is corrected away from the fallback (drives the page H1 + list).
    const t = await env.DB.prepare('SELECT title FROM topics WHERE id = ?').bind(topic.id).first<{ title: string }>();
    expect(t!.title).toBe('Withdraw 540,750 ada for Oura by TxPipe');

    // The opening post is re-rendered with the now-available abstract.
    const body = await getOpeningPostBody(env.DB, topic.id);
    expect(body).toContain('This Treasury Withdrawal funds Oura by TxPipe.');
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
  const EPOCH_200_MS = 1740441600000; // epochStartUnix(200, preprod) * 1000

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

  it('stamps a newly synced governance topic and its feed event with the exact block time', async () => {
    const txHash = 'ab'.repeat(32);
    const BLOCK_TIME = 1_742_400_123; // unix seconds, well after the epoch-200 boundary
    const NOW = 1_742_500_000_000;
    let n = 0;
    await syncGovernanceActions({
      koios: fakeKoios([
        {
          proposal_id: 'gov_action1exact',
          proposal_tx_hash: txHash,
          proposal_index: 0,
          proposal_type: 'InfoAction',
          meta_url: null,
          meta_hash: null,
          proposed_epoch: 200,
          expiration: 230,
          block_time: BLOCK_TIME,
        },
      ]),
      db: env.DB,
      network: 'preprod',
      now: NOW,
      rand: () => `rex${n++}`,
      fetchImpl: fetchOk,
    });
    const row = await env.DB
      .prepare(
        `SELECT t.id AS topicId, t.created_at AS tc, t.last_post_at AS tl, p.created_at AS pc
         FROM topics t
         JOIN governance_actions ga ON ga.topic_id = t.id
         JOIN posts p ON p.topic_id = t.id
         WHERE ga.id = ?`,
      )
      .bind(`${txHash}#0`)
      .first<{ topicId: string; tc: number; tl: number; pc: number }>();
    expect(row).toMatchObject({ tc: BLOCK_TIME * 1000, tl: BLOCK_TIME * 1000, pc: BLOCK_TIME * 1000 });

    // The feed event carries the same exact date, while notified_at stays the
    // detection time so notification cursors still see the action as new.
    const ev = await env.DB
      .prepare("SELECT created_at, notified_at FROM activity WHERE type = 'gov_created' AND topic_id = ?")
      .bind(row!.topicId)
      .first<{ created_at: number; notified_at: number }>();
    expect(ev!.created_at).toBe(BLOCK_TIME * 1000);
    expect(ev!.notified_at).toBe(NOW);
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

  it('corrects topic, system post and feed event to the exact submission time when known', async () => {
    // Row stamped at the epoch boundary by the old code; the action row knows the
    // exact block time (~2.8 days into the epoch), the feed event was detected later.
    const SUB_MS = EPOCH_200_MS + 244_191_000;
    const DETECT_MS = EPOCH_200_MS + 300_000_000;
    const topicId = 'bf-topic-exact';
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at)
           VALUES (?, 'governance-actions', 'gov-sync', 'governance', 'Exact Time', 'exact-time-bf4', 1, ?, ?)`,
        )
        .bind(topicId, EPOCH_200_MS, EPOCH_200_MS),
      env.DB
        .prepare(
          `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at)
           VALUES ('bf-post-exact', ?, 'gov-sync', 'b', '<p>b</p>', ?)`,
        )
        .bind(topicId, EPOCH_200_MS),
      buildInsertGovernanceAction(env.DB, {
        id: 'bf-action-exact',
        proposalId: 'gov_action1bf4',
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
        submittedAt: SUB_MS,
        expiryEpoch: null,
        metaVersion: META_EXTRACT_VERSION,
        topicId,
        now: EPOCH_200_MS,
      }),
      activityInsert(env.DB, { type: 'gov_created', topicId, createdAt: EPOCH_200_MS, notifiedAt: DETECT_MS }),
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
    expect(fixed).toEqual({ tc: SUB_MS, tl: SUB_MS, pc: SUB_MS });

    // The feed event moves to the exact date; the notification cursor value stays.
    const ev = await env.DB
      .prepare("SELECT created_at, notified_at FROM activity WHERE type = 'gov_created' AND topic_id = ?")
      .bind(topicId)
      .first<{ created_at: number; notified_at: number }>();
    expect(ev).toEqual({ created_at: SUB_MS, notified_at: DETECT_MS });

    const r2 = await backfillGovTopicSubmittedAt({ db: env.DB, network: 'preprod', limit: 200 });
    expect(r2.updated).toBe(0);
  });

  it('corrects created_at and the system post on a replied topic but preserves last_post_at', async () => {
    // A replied topic must keep its reply-driven last_post_at (list ordering), while
    // the opening post and topic created_at still move to the exact submission time.
    const SUB_MS = EPOCH_200_MS + 100_000_000;
    const REPLY_MS = EPOCH_200_MS + 400_000_000;
    const topicId = 'bf-topic-replied';
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at)
           VALUES (?, 'governance-actions', 'gov-sync', 'governance', 'Has Replies', 'has-replies-bf2', 2, ?, ?)`,
        )
        .bind(topicId, REPLY_MS, EPOCH_200_MS),
      env.DB
        .prepare(
          `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at)
           VALUES ('bf-post-replied-sys', ?, 'gov-sync', 's', '<p>s</p>', ?)`,
        )
        .bind(topicId, EPOCH_200_MS),
      env.DB
        .prepare(
          `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, created_at)
           VALUES ('bf-post-replied-reply', ?, 'drep-user', 'r', '<p>r</p>', ?)`,
        )
        .bind(topicId, REPLY_MS),
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
        submittedAt: SUB_MS,
        expiryEpoch: null,
        metaVersion: META_EXTRACT_VERSION,
        topicId,
        now: EPOCH_200_MS,
      }),
    ]);

    await backfillGovTopicSubmittedAt({ db: env.DB, network: 'preprod', limit: 200 });

    const topic = await env.DB
      .prepare('SELECT created_at, last_post_at FROM topics WHERE id = ?')
      .bind(topicId)
      .first<{ created_at: number; last_post_at: number }>();
    expect(topic).toEqual({ created_at: SUB_MS, last_post_at: REPLY_MS });

    const sys = await env.DB
      .prepare('SELECT created_at FROM posts WHERE id = ?')
      .bind('bf-post-replied-sys')
      .first<{ created_at: number }>();
    const reply = await env.DB
      .prepare('SELECT created_at FROM posts WHERE id = ?')
      .bind('bf-post-replied-reply')
      .first<{ created_at: number }>();
    expect(sys!.created_at).toBe(SUB_MS);
    expect(reply!.created_at).toBe(REPLY_MS);
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
