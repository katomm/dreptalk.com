/// <reference types="@cloudflare/workers-types" />
// searchAll + resolveIdentifier tests against real D1 with the FTS migration
// applied. Fixtures are raw inserts so each test controls exactly the columns
// the queries read.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { searchAll, resolveIdentifier } from './search.js';
import { upsertDrep } from './dreps.js';
import { encodeBech32 } from '../crypto/bech32.js';

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

async function seedPost(o: { id: string; topicId: string; body: string; deleted?: number }) {
  await db()
    .prepare(
      `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, deleted, created_at)
       VALUES (?, ?, 'system', ?, ?, ?, ?)`,
    )
    .bind(o.id, o.topicId, o.body, `<p>${o.body}</p>`, o.deleted ?? 0, NOW)
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
    anchorUrl: null,
    anchorHash: null,
    anchorStatus: 'pending',
    lastSyncedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

const GA1 = `${'a'.repeat(64)}#0`;

describe('searchAll', () => {
  it('returns a direct governance action hit with its topic href', async () => {
    await seedTopic({ id: 'gt1', title: 'Raise treasury cap', slug: 'ga-treasury', source: 'governance', categorySlug: 'governance-actions' });
    await seedGa({ id: GA1, proposalId: 'gov_action1one', title: 'Raise treasury cap', abstract: 'Lift the net change limit.', topicId: 'gt1' });

    const r = await searchAll(db(), '"treasury"*');
    expect(r.governanceActions).toHaveLength(1);
    expect(r.governanceActions[0]).toMatchObject({
      href: '/t/ga-treasury',
      title: 'Raise treasury cap',
      type: 'InfoAction',
      status: 'active',
      discussionMatches: 0,
    });
    expect(r.discussions).toHaveLength(0);
  });

  it('merges post hits in a governance topic into the GA group and dedupes with the direct hit', async () => {
    await seedTopic({ id: 'gt1', title: 'Raise treasury cap', slug: 'ga-treasury', source: 'governance', categorySlug: 'governance-actions' });
    await seedGa({ id: GA1, proposalId: 'gov_action1one', title: 'Raise treasury cap', abstract: 'About the treasury.', topicId: 'gt1' });
    await seedPost({ id: 'p1', topicId: 'gt1', body: 'The treasury argument is weak.' });
    await seedPost({ id: 'p2', topicId: 'gt1', body: 'Another treasury take.' });

    const r = await searchAll(db(), '"treasury"*');
    expect(r.governanceActions).toHaveLength(1);
    expect(r.governanceActions[0].discussionMatches).toBe(2);
    expect(r.discussions).toHaveLength(0);
  });

  it('routes user-topic hits (title and posts) into discussions, merged per topic', async () => {
    await seedTopic({ id: 'ut1', title: 'Treasury chat', slug: 'treasury-chat' });
    await seedPost({ id: 'p1', topicId: 'ut1', body: 'I love the treasury.' });
    await seedPost({ id: 'p2', topicId: 'ut1', body: 'treasury treasury treasury' });

    const r = await searchAll(db(), '"treasury"*');
    expect(r.discussions).toHaveLength(1);
    expect(r.discussions[0]).toMatchObject({ href: '/t/treasury-chat', title: 'Treasury chat', categorySlug: 'general' });
    expect(r.governanceActions).toHaveLength(0);
  });

  it('excludes deleted posts and deleted topics', async () => {
    await seedTopic({ id: 'ut1', title: 'Old treasury thread', slug: 'old', deleted: 1 });
    await seedTopic({ id: 'ut2', title: 'Live thread', slug: 'live' });
    await seedPost({ id: 'p1', topicId: 'ut2', body: 'treasury mention', deleted: 1 });

    const r = await searchAll(db(), '"treasury"*');
    expect(r.discussions).toHaveLength(0);
  });

  it('caps every group at 5', async () => {
    for (let i = 0; i < 7; i++) {
      await seedTopic({ id: `t${i}`, title: `Treasury thread ${i}`, slug: `tt-${i}` });
    }
    const r = await searchAll(db(), '"treasury"*');
    expect(r.discussions).toHaveLength(5);
  });

  it('finds dreps by name and bio with display fields', async () => {
    await upsertDrep(db(), drepArgs({ drepId: 'drep1one', name: 'Treasury Watcher', bio: 'I watch budgets.' }));
    const r = await searchAll(db(), '"treasury"*');
    expect(r.dreps).toHaveLength(1);
    expect(r.dreps[0]).toMatchObject({
      href: '/dreps/drep1one',
      drepId: 'drep1one',
      name: 'Treasury Watcher',
      status: 'registered',
      votingPower: '5000000000',
    });
  });
});

describe('resolveIdentifier', () => {
  it('resolves a bech32 gov action id via proposal_id', async () => {
    await seedTopic({ id: 'gt1', title: 'T', slug: 'ga-slug', source: 'governance' });
    await seedGa({ id: GA1, proposalId: 'gov_action1one', title: 'The Action', topicId: 'gt1' });
    const hit = await resolveIdentifier(db(), { kind: 'gov-action', by: 'proposal_id', value: 'gov_action1one' });
    expect(hit).toEqual({ kind: 'governance-action', href: '/t/ga-slug', label: 'The Action' });
  });

  it('resolves a tx hash with and without index', async () => {
    await seedTopic({ id: 'gt1', title: 'T', slug: 'ga-slug', source: 'governance' });
    await seedGa({ id: GA1, proposalId: 'gov_action1one', title: null, topicId: 'gt1' });
    const exact = await resolveIdentifier(db(), { kind: 'gov-action', by: 'id', value: GA1 });
    expect(exact).toMatchObject({ kind: 'governance-action', href: '/t/ga-slug', label: GA1 });
    const prefix = await resolveIdentifier(db(), { kind: 'gov-action', by: 'id-prefix', value: `${'a'.repeat(64)}#%` });
    expect(prefix).toMatchObject({ href: '/t/ga-slug' });
  });

  it('resolves a drep by stored id, and by hex when the pasted flavor differs', async () => {
    const hash = new Uint8Array(28).fill(0xab);
    const hex = 'ab'.repeat(28);
    const cip129 = encodeBech32('drep', new Uint8Array([0x22, ...hash]));
    await upsertDrep(db(), drepArgs({ drepId: 'drep1stored', hex, name: 'Stored DRep' }));

    const direct = await resolveIdentifier(db(), { kind: 'drep', drepId: 'drep1stored' });
    expect(direct).toEqual({ kind: 'drep', href: '/dreps/drep1stored', label: 'Stored DRep' });

    const viaHex = await resolveIdentifier(db(), { kind: 'drep', drepId: cip129 });
    expect(viaHex).toEqual({ kind: 'drep', href: '/dreps/drep1stored', label: 'Stored DRep' });
  });

  it('returns null for unknown identifiers', async () => {
    expect(await resolveIdentifier(db(), { kind: 'gov-action', by: 'proposal_id', value: 'gov_action1nope' })).toBeNull();
    expect(await resolveIdentifier(db(), { kind: 'drep', drepId: 'drep1nope' })).toBeNull();
  });
});
