/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/vote/record.
// Calls the exported POST handler directly with a synthetic APIContext so
// the test runs inside the real Workers runtime (D1, KV via cloudflare:test)
// without needing an HTTP server or the Astro middleware chain.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getViewerVote } from '@/lib/db/drepVotes';
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
});
