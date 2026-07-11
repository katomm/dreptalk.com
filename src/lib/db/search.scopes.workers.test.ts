/// <reference types="@cloudflare/workers-types" />
// Scoped pagination + facet counts against real D1 with the FTS migration
// applied. Seed helpers mirror search.workers.test.ts (raw inserts, so each
// test controls exactly the columns the queries read).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { countScopes, searchForumPage, searchGovernancePage, searchDrepsPage, PAGE_SIZE } from './search.js';
import { upsertDrep } from './dreps.js';

const db = () => env.DB;
const NOW = 1_749_000_000_000;

async function seedTopic(o: {
  id: string;
  title: string;
  slug: string;
  source?: 'user' | 'governance';
  categorySlug?: string;
  deleted?: number;
  postCount?: number;
}) {
  await db()
    .prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
       VALUES (?, ?, 'system', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(o.id, o.categorySlug ?? 'general', o.source ?? 'user', o.title, o.slug, o.postCount ?? 1, NOW, NOW, o.deleted ?? 0)
    .run();
}

async function seedPost(o: { id: string; topicId: string; body: string; deleted?: number; hidden?: number }) {
  await db()
    .prepare(
      `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, deleted, hidden, created_at)
       VALUES (?, ?, 'system', ?, ?, ?, ?, ?)`,
    )
    .bind(o.id, o.topicId, o.body, `<p>${o.body}</p>`, o.deleted ?? 0, o.hidden ?? 0, NOW)
    .run();
}

async function seedGa(o: {
  id: string;
  proposalId: string;
  title?: string | null;
  abstract?: string | null;
  type?: string;
  status?: string;
  topicId?: string | null;
}) {
  await db()
    .prepare(
      `INSERT INTO governance_actions (id, proposal_id, type, title, abstract, status, topic_id, created_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(o.id, o.proposalId, o.type ?? 'InfoAction', o.title ?? null, o.abstract ?? null, o.status ?? 'active', o.topicId ?? null, NOW, NOW)
    .run();
}

function drepArgs(overrides: Partial<Parameters<typeof upsertDrep>[1]>): Parameters<typeof upsertDrep>[1] {
  return {
    drepId: 'drep1fixture',
    hex: null,
    hasScript: false,
    status: 'registered',
    active: true,
    deposit: null,
    votingPower: '5000000000',
    expiresEpochNo: null,
    name: null,
    bio: null,
    imageUrl: null,
    imageContentHash: null,
    imageStoredUrl: null,
    imageFetchFailedAt: null,
    links: null,
    motivations: null,
    qualifications: null,
    paymentAddress: null,
    doNotList: false,
    anchorUrl: null,
    anchorHash: null,
    anchorStatus: 'pending',
    profileExtractVersion: 0,
    lastSyncedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

describe('searchForumPage', () => {
  it('returns distinct matching topics with total, deduped across title and post hits', async () => {
    await seedTopic({ id: 't1', title: 'Treasury budget alpha', slug: 't1' });
    await seedPost({ id: 'p1', topicId: 't1', body: 'more about treasury budget' });
    await seedTopic({ id: 't2', title: 'Unrelated heading', slug: 't2' });
    await seedPost({ id: 'p2', topicId: 't2', body: 'treasury discussion continues' });

    const res = await searchForumPage(db(), 'treasury*', 1);
    expect(res.total).toBe(2);
    const slugs = res.hits.map((h) => h.href);
    expect(slugs).toContain('/t/t1/');
    expect(slugs).toContain('/t/t2/');
    expect(slugs.filter((s) => s === '/t/t1/')).toHaveLength(1);
  });

  it('excludes deleted topics and hidden or deleted posts, keeping title matches', async () => {
    await seedTopic({ id: 't3', title: 'zeta gamma', slug: 't3' });
    await seedPost({ id: 'p3', topicId: 't3', body: 'zeta secret', hidden: 1 });
    await seedTopic({ id: 't4', title: 'zeta hidden topic', slug: 't4', deleted: 1 });

    const res = await searchForumPage(db(), 'zeta*', 1);
    expect(res.total).toBe(1);
    expect(res.hits[0].href).toBe('/t/t3/');
    expect(res.hits[0].snippet).toBeNull();
  });

  it('excludes governance-synced topics (they belong to the Governance scope)', async () => {
    await seedTopic({ id: 'gt', title: 'omega governance thread', slug: 'gt', source: 'governance', categorySlug: 'governance-actions' });
    const res = await searchForumPage(db(), 'omega*', 1);
    expect(res.total).toBe(0);
    expect(res.hits).toEqual([]);
  });

  it('paginates', async () => {
    for (let i = 0; i < PAGE_SIZE + 3; i++) {
      await seedTopic({ id: `pg${i}`, title: `kappa item ${i}`, slug: `pg${i}` });
    }
    const p1 = await searchForumPage(db(), 'kappa*', 1);
    const p2 = await searchForumPage(db(), 'kappa*', 2);
    expect(p1.total).toBe(PAGE_SIZE + 3);
    expect(p1.hits).toHaveLength(PAGE_SIZE);
    expect(p2.hits).toHaveLength(3);
  });
});

describe('searchGovernancePage', () => {
  it('returns paginated GA hits with total', async () => {
    for (let i = 0; i < PAGE_SIZE + 2; i++) {
      const id = `${String(i).padStart(2, '0')}${'a'.repeat(62)}#0`;
      await seedTopic({ id: `gtt${i}`, title: `sigma action ${i}`, slug: `gtt${i}`, source: 'governance' });
      await seedGa({ id, proposalId: `gov_action${i}`, title: `sigma action ${i}`, topicId: `gtt${i}` });
    }
    const p1 = await searchGovernancePage(db(), 'sigma*', 1);
    const p2 = await searchGovernancePage(db(), 'sigma*', 2);
    expect(p1.total).toBe(PAGE_SIZE + 2);
    expect(p1.hits).toHaveLength(PAGE_SIZE);
    expect(p2.hits).toHaveLength(2);
    expect(p1.hits[0].href).toMatch(/^\/t\/gtt/);
  });
});

describe('searchDrepsPage', () => {
  it('returns DRep hits with total', async () => {
    await upsertDrep(db(), drepArgs({ drepId: 'drep1aaa', name: 'Tau Delegate', bio: 'tau focused rep' }));
    const res = await searchDrepsPage(db(), 'tau*', 1);
    expect(res.total).toBe(1);
    expect(res.hits[0].name).toBe('Tau Delegate');
  });
});

describe('countScopes', () => {
  it('counts each entity independently', async () => {
    await seedTopic({ id: 'c1', title: 'rho topic', slug: 'c1' });
    await seedTopic({ id: 'cg', title: 'rho action', slug: 'cg', source: 'governance' });
    await seedGa({ id: `${'b'.repeat(64)}#0`, proposalId: 'gov_actionrho', title: 'rho action', topicId: 'cg' });
    const counts = await countScopes(db(), 'rho*');
    expect(counts.forum).toBe(1);
    expect(counts.governance).toBe(1);
    expect(counts.dreps).toBe(0);
  });
});
