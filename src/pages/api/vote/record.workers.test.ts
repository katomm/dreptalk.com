/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/vote/record.
// Calls the exported POST handler directly with a synthetic APIContext so
// the test runs inside the real Workers runtime (D1, KV via cloudflare:test)
// without needing an HTTP server or the Astro middleware chain.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getViewerVote } from '@/lib/db/drepVotes';
import { buildVoteRationale, MAX_VOTE_RATIONALE } from '@/lib/governance/voteRationale';
import { POST } from './record';

const NOW = 1_752_000_000;
const DREP_ID = `drep1${'a'.repeat(50)}`;
const USER_ID = 'user-drep-1';
const GA_ID = `${'a'.repeat(64)}#0`;
const TX_HASH = 'b'.repeat(64);

// Insert a governance_actions row with a topic so rationale upsert works.
async function seedGovAction(topicId: string | null = null) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO governance_actions (id, type, title, status, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', 'Test Action', 'active', ?, ?, ?)`,
  )
    .bind(GA_ID, topicId, NOW, NOW)
    .run();
}

// Insert a topic so the governance_actions.topic_id FK is satisfied.
// The topics table stores category_slug as a plain TEXT column, no separate
// categories table.
async function seedTopic(): Promise<string> {
  const topicId = 'topic-vote-record-1';
  const slug = 'test-vote-record-topic';
  await env.DB.prepare(
    `INSERT OR IGNORE INTO topics (id, category_slug, author_id, title, slug, created_at, last_post_at)
     VALUES (?, 'general', ?, 'Test topic', ?, ?, ?)`,
  )
    .bind(topicId, USER_ID, slug, NOW, NOW)
    .run();
  return topicId;
}

// Insert a user row with is_drep=1 and drep_id set.
async function seedUser() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, drep_id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at)
     VALUES (?, ?, 1, 0, 0, 0, 'drep', 'active', ?, ?)`,
  )
    .bind(USER_ID, DREP_ID, NOW, NOW)
    .run();
}

// Build a synthetic APIContext for POST /api/vote/record.
// locals.user is injected directly, bypassing the Astro middleware.
function makeCtx(opts: {
  user: { id: string; roles: string[] } | null;
  body: Record<string, unknown>;
}) {
  const request = new Request('https://dreptalk.com/api/vote/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.body),
  });
  // Provide the minimal App.Locals shape the handler reads.
  const locals = { user: opts.user } as unknown as App.Locals;
  // Minimal APIContext: handler only destructures { request, locals }.
  return { request, locals } as Parameters<typeof POST>[0];
}

describe('POST /api/vote/record', () => {
  it('returns 401 when the caller is not logged in', async () => {
    const res = await POST(makeCtx({ user: null, body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH } }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when the caller is logged in but not a DRep', async () => {
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['proposer'] },
      body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH },
    }));
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid input (bad gaId format)', async () => {
    await seedUser();
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: 'not-a-valid-ga-id', vote: 'yes', txHash: TX_HASH },
    }));
    expect(res.status).toBe(400);
  });

  it('writes a pending vote for the logged-in DRep', async () => {
    await seedUser();
    await seedGovAction();
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);

    const v = await getViewerVote(env.DB, GA_ID, DREP_ID);
    expect(v?.vote).toBe('yes');
    expect(v?.local_status).toBe('pending');
    expect(v?.tx_hash).toBe(TX_HASH);
  });

  it('creates a rationale post when rationaleText is present', async () => {
    await seedUser();
    const topicId = await seedTopic();
    await seedGovAction(topicId);

    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: {
        gaId: GA_ID,
        vote: 'no',
        txHash: TX_HASH,
        rationaleUrl: 'https://dreptalk.com/vote-rationale/x.json',
        rationaleText: 'Because this is a bad idea.',
        crossPost: true,
      },
    }));
    expect(res.status).toBe(200);

    const rows = (
      await env.DB.prepare(
        `SELECT * FROM posts WHERE source = 'vote_rationale' AND author_id = ?`,
      )
        .bind(USER_ID)
        .all<{ vote: string; body_md: string }>()
    ).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].vote).toBe('no');
    expect(rows[0].body_md).toBe('Because this is a bad idea.');
  });

  it('stamps the rationale post in ms and the vote in seconds', async () => {
    // Regression: a single seconds-valued clock was shared between drep_votes
    // (block_time, Unix seconds) and posts (created_at, ms). The seconds value
    // sorted the rationale before the opening post, so it inherited the System
    // identity and rendered as "56y ago". Each table must get its own unit.
    await seedUser();
    const topicId = await seedTopic();
    await seedGovAction(topicId);

    const before = Date.now();
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH, rationaleText: 'Timestamped rationale.', crossPost: true },
    }));
    expect(res.status).toBe(200);

    const post = await env.DB.prepare(
      `SELECT created_at FROM posts WHERE source = 'vote_rationale' AND author_id = ?`,
    )
      .bind(USER_ID)
      .first<{ created_at: number }>();
    // posts.created_at is milliseconds, in the same range as Date.now().
    expect(post?.created_at).toBeGreaterThanOrEqual(before);

    const vote = await env.DB.prepare(
      `SELECT synced_at FROM drep_votes WHERE ga_id = ? AND voter_id = ?`,
    )
      .bind(GA_ID, DREP_ID)
      .first<{ synced_at: number }>();
    // drep_votes.synced_at is Unix seconds: ~1000x smaller than the ms post stamp.
    expect(vote?.synced_at).toBeLessThan(before / 1000 + 60);
    expect(vote?.synced_at).toBeGreaterThan(before / 1000 - 60);
  });

  it('stores the canonicalized rationale on the post, not the raw input', async () => {
    await seedUser();
    const topicId = await seedTopic();
    await seedGovAction(topicId);

    // Dirty input: leading/trailing whitespace, CRLF line endings, 3+ blank
    // lines, and more than MAX_VOTE_RATIONALE characters. The on-chain anchor
    // hashes the sanitized/sliced text, so the frozen post (shown as the
    // on-chain rationale) must store that same canonical text, never the raw
    // client string. Otherwise the post diverges from the hashed/hosted bytes.
    const dirty = `  \r\n\r\n  Leading whitespace and CRLFs.\r\n\r\n\r\n\r\nBlank lines collapse.\r\n${'x'.repeat(MAX_VOTE_RATIONALE)}  \r\n  `;
    const canonical = buildVoteRationale({ rationale: dirty }).rationale;

    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH, rationaleText: dirty, crossPost: true },
    }));
    expect(res.status).toBe(200);

    const rows = (
      await env.DB.prepare(
        `SELECT body_md FROM posts WHERE source = 'vote_rationale' AND author_id = ?`,
      )
        .bind(USER_ID)
        .all<{ body_md: string }>()
    ).results;
    expect(rows).toHaveLength(1);
    // The stored body is exactly the text the anchor commits to.
    expect(rows[0].body_md).toBe(canonical);
    // And it is NOT the raw input: canonicalization actually happened.
    expect(rows[0].body_md).not.toBe(dirty);
    // Canonicalization invariants: capped, trimmed, no carriage returns.
    expect(rows[0].body_md.length).toBeLessThanOrEqual(MAX_VOTE_RATIONALE);
    expect(rows[0].body_md).toBe(rows[0].body_md.trim());
    expect(rows[0].body_md).not.toContain('\r');
  });

  it('mirrors a self-cast rationale into action_rationale for the Positions tab', async () => {
    await seedUser();
    const topicId = await seedTopic();
    await seedGovAction(topicId);
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH, rationaleText: 'Native rationale.' },
    }));
    expect(res.status).toBe(200);
    const row = await env.DB
      .prepare(`SELECT body_html, source FROM action_rationale WHERE ga_id = ? AND voter_id = ?`)
      .bind(GA_ID, DREP_ID).first<{ body_html: string; source: string }>();
    expect(row?.source).toBe('dreptalk');
    expect(row?.body_html).toContain('Native rationale');
  });

  it('does not create a rationale post when the action has no topic', async () => {
    await seedUser();
    await seedGovAction(null); // no topic_id
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: {
        gaId: GA_ID,
        vote: 'yes',
        txHash: TX_HASH,
        rationaleText: 'Some rationale',
      },
    }));
    // Vote still records OK; rationale post is silently skipped.
    expect(res.status).toBe(200);
    const rows = (
      await env.DB.prepare(
        `SELECT * FROM posts WHERE source = 'vote_rationale' AND author_id = ?`,
      )
        .bind(USER_ID)
        .all()
    ).results;
    expect(rows).toHaveLength(0);
  });

  it('does not create a discussion post when crossPost is omitted', async () => {
    await seedUser();
    const topicId = await seedTopic();
    await seedGovAction(topicId);
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH, rationaleText: 'Kept off the forum.' },
    }));
    expect(res.status).toBe(200);
    const posts = (await env.DB.prepare(
      `SELECT * FROM posts WHERE source = 'vote_rationale' AND author_id = ?`,
    ).bind(USER_ID).all()).results;
    expect(posts).toHaveLength(0);
    // The Positions-tab mirror is still written even without opting in.
    const ar = await env.DB.prepare(
      `SELECT body_html FROM action_rationale WHERE ga_id = ? AND voter_id = ?`,
    ).bind(GA_ID, DREP_ID).first<{ body_html: string }>();
    expect(ar?.body_html).toContain('Kept off the forum');
  });

  it('increments topic.post_count when cross-posting', async () => {
    await seedUser();
    const topicId = await seedTopic();
    await seedGovAction(topicId);
    await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH, rationaleText: 'Shared to discussion.', crossPost: true },
    }));
    const topic = await env.DB.prepare(
      `SELECT post_count FROM topics WHERE id = ?`,
    ).bind(topicId).first<{ post_count: number }>();
    expect(topic?.post_count).toBe(1);
  });

  it('re-voting with crossPost off removes the existing cross-post and decrements post_count', async () => {
    await seedUser();
    const topicId = await seedTopic();
    await seedGovAction(topicId);
    // First vote: opted in, creates the cross-post and bumps the counter.
    await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH, rationaleText: 'First take.', crossPost: true },
    }));
    // Re-vote: box unchecked, must remove the cross-post and undo the bump.
    await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'no', txHash: TX_HASH, rationaleText: 'Changed my mind.', crossPost: false },
    }));
    const live = (await env.DB.prepare(
      `SELECT * FROM posts WHERE source = 'vote_rationale' AND author_id = ? AND deleted = 0`,
    ).bind(USER_ID).all()).results;
    expect(live).toHaveLength(0);
    const topic = await env.DB.prepare(
      `SELECT post_count FROM topics WHERE id = ?`,
    ).bind(topicId).first<{ post_count: number }>();
    expect(topic?.post_count).toBe(0);
  });

  it('re-counts a revived cross-post so it is not shown-but-uncounted', async () => {
    await seedUser();
    const topicId = await seedTopic();
    await seedGovAction(topicId);
    // Opt in, then opt out: post removed, count back to 0.
    await POST(makeCtx({ user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH, rationaleText: 'On.', crossPost: true } }));
    await POST(makeCtx({ user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'no', txHash: TX_HASH, rationaleText: 'Off.', crossPost: false } }));
    // Opt in again: the dead row is revived AND re-counted.
    await POST(makeCtx({ user: { id: USER_ID, roles: ['drep'] },
      body: { gaId: GA_ID, vote: 'yes', txHash: TX_HASH, rationaleText: 'On again.', crossPost: true } }));
    const live = (await env.DB.prepare(
      `SELECT * FROM posts WHERE source = 'vote_rationale' AND author_id = ? AND deleted = 0`,
    ).bind(USER_ID).all()).results;
    expect(live).toHaveLength(1);
    const topic = await env.DB.prepare(`SELECT post_count FROM topics WHERE id = ?`).bind(topicId).first<{ post_count: number }>();
    expect(topic?.post_count).toBe(1);
  });
});

const GA_ID_2 = `${'c'.repeat(64)}#1`;

async function seedSecondGovAction() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO governance_actions (id, type, title, status, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', 'Second Action', 'active', NULL, ?, ?)`,
  ).bind(GA_ID_2, NOW, NOW).run();
}

describe('POST /api/vote/record (batch)', () => {
  it('records every vote of a batch under one txHash', async () => {
    await seedUser();
    await seedGovAction();
    await seedSecondGovAction();

    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: {
        txHash: TX_HASH,
        votes: [
          { gaId: GA_ID, vote: 'yes' },
          { gaId: GA_ID_2, vote: 'abstain' },
        ],
      },
    }));
    expect(res.status).toBe(200);

    const v1 = await getViewerVote(env.DB, GA_ID, DREP_ID);
    const v2 = await getViewerVote(env.DB, GA_ID_2, DREP_ID);
    expect(v1?.vote).toBe('yes');
    expect(v2?.vote).toBe('abstain');
    expect(v1?.tx_hash).toBe(TX_HASH);
    expect(v2?.tx_hash).toBe(TX_HASH);
    expect(v1?.local_status).toBe('pending');
    expect(v2?.local_status).toBe('pending');
  });

  it('rejects a batch with duplicate gaIds', async () => {
    await seedUser();
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: {
        txHash: TX_HASH,
        votes: [
          { gaId: GA_ID, vote: 'yes' },
          { gaId: GA_ID, vote: 'no' },
        ],
      },
    }));
    expect(res.status).toBe(400);
  });

  it('rejects an empty batch', async () => {
    await seedUser();
    const res = await POST(makeCtx({
      user: { id: USER_ID, roles: ['drep'] },
      body: { txHash: TX_HASH, votes: [] },
    }));
    expect(res.status).toBe(400);
  });
});
