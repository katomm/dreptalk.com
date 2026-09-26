/// <reference types="@cloudflare/workers-types" />
// handleSearch against a real D1: grouped full text, scopes with totals and
// facet counts, the rationales scope and the identifier fast path. The FTS
// degradation case lives in its own file because it drops the FTS tables.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleSearch } from './handler.js';
import { indexContent } from './content.js';
import { PAGE_SIZE } from './scopes.js';
import { upsertActionRationale } from '../db/actionRationale.js';
import { upsertDrep } from '../db/dreps.js';
import { encodeBech32 } from '../crypto/bech32.js';

const db = () => env.DB;
const NOW = 1_749_000_000_000;

async function seedTopic(o: {
  id: string;
  title: string;
  slug: string;
  source?: 'user' | 'governance';
  category?: string;
}) {
  await db()
    .prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
       VALUES (?, ?, 'system', ?, ?, ?, 1, ?, ?, 0)`,
    )
    .bind(o.id, o.category ?? 'general', o.source ?? 'user', o.title, o.slug, NOW, NOW)
    .run();
}

async function seedGa(o: {
  id: string;
  proposalId: string;
  title: string;
  topicId: string;
  slug?: string;
  abstract?: string | null;
  status?: string;
}) {
  await seedTopic({
    id: o.topicId,
    title: o.title,
    slug: o.slug ?? `s-${o.topicId}`,
    source: 'governance',
    category: 'governance-actions',
  });
  await db()
    .prepare(
      `INSERT INTO governance_actions (id, proposal_id, type, title, abstract, status, topic_id, created_at, last_synced_at)
       VALUES (?, ?, 'InfoAction', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(o.id, o.proposalId, o.title, o.abstract ?? null, o.status ?? 'active', o.topicId, NOW, NOW)
    .run();
}

async function seedPost(o: { id: string; topicId: string; body: string }) {
  await db()
    .prepare(
      `INSERT INTO posts (id, topic_id, author_id, body_md, body_html, deleted, hidden, created_at)
       VALUES (?, ?, 'system', ?, ?, 0, 0, ?)`,
    )
    .bind(o.id, o.topicId, o.body, `<p>${o.body}</p>`, NOW)
    .run();
}

function drepArgs(id: string, name: string, hex: string | null = null): Parameters<typeof upsertDrep>[1] {
  return {
    drepId: id, hex, hasScript: false, status: 'registered', active: true,
    deposit: null, votingPower: '5000000000', expiresEpochNo: null, name, bio: null,
    imageUrl: null, imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: null,
    links: null, motivations: null, qualifications: null, paymentAddress: null, doNotList: false,
    anchorUrl: null, anchorHash: null, anchorStatus: 'pending', profileExtractVersion: 0, lastSyncedAt: NOW, createdAt: NOW,
  };
}

async function seedRationale(gaId: string, slug: string, title: string, voterId: string, name: string, vote: string, bodyHtml: string) {
  await seedGa({ id: gaId, proposalId: `p_${gaId}`, title, topicId: `t-${gaId}`, slug, status: 'enacted' });
  await upsertDrep(db(), drepArgs(voterId, name));
  await db().prepare(
    `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time) VALUES (?, 'DRep', ?, ?, ?, ?)`,
  ).bind(gaId, voterId, vote, NOW, 1_700_000_000).run();
  await upsertActionRationale(db(), { gaId, voterId, bodyHtml, source: 'onchain', anchorUrl: 'https://x', status: 'ok', createdAt: NOW, now: NOW });
}

const GA1 = `${'b'.repeat(64)}#0`;

async function seedBudgetGa() {
  await seedGa({
    id: GA1,
    proposalId: 'gov_action1budget',
    title: 'Budget action',
    topicId: 'gt1',
    slug: 'budget-action',
    abstract: 'Spend wisely.',
  });
}

describe('handleSearch', () => {
  it('returns empty groups for short or empty queries', async () => {
    expect(await handleSearch(db(), null)).toMatchObject({ query: '', exact: null, governanceActions: [] });
    expect(await handleSearch(db(), 'a')).toMatchObject({ query: 'a', exact: null });
  });

  it('normalizes whitespace and caps length at 120 chars', async () => {
    const long = `bud  get   ${'x'.repeat(300)}`;
    const r = await handleSearch(db(), long);
    expect(r.query.length).toBeLessThanOrEqual(120);
    expect(r.query.startsWith('bud get')).toBe(true);
  });

  it('short-circuits to the exact hit on a resolved identifier', async () => {
    await seedBudgetGa();
    const r = await handleSearch(db(), 'gov_action1budget');
    expect(r.exact).toEqual({ kind: 'governance-action', href: '/t/budget-action/', label: 'Budget action' });
    expect(r.governanceActions).toHaveLength(0);
    expect(r.discussions).toHaveLength(0);
    expect(r.dreps).toHaveLength(0);
  });

  it('falls through to full text on an unresolved identifier', async () => {
    const r = await handleSearch(db(), 'gov_action1unknown');
    expect(r.exact).toBeNull();
    expect(r.governanceActions).toHaveLength(0);
  });

  it('returns grouped full-text results', async () => {
    await seedBudgetGa();
    const r = await handleSearch(db(), 'budget');
    expect(r.exact).toBeNull();
    expect(r.governanceActions).toHaveLength(1);
    expect(r.governanceActions[0].href).toBe('/t/budget-action/');
  });
});

describe('handleSearch scoped', () => {
  it('forum scope returns only discussions with a total', async () => {
    await seedTopic({ id: 'f1', title: 'delta forum topic', slug: 'f1' });
    const body = await handleSearch(db(), 'delta', { scope: 'forum', page: 1 });
    expect(body.scope).toBe('forum');
    expect(body.page).toBe(1);
    expect(body.discussions).toHaveLength(1);
    expect(body.governanceActions).toEqual([]);
    expect(body.dreps).toEqual([]);
    expect(body.total).toBe(1);
    expect(body.exact).toBeNull();
  });

  it('governance scope returns only governance actions with a total', async () => {
    await seedGa({ id: `${'a'.repeat(64)}#0`, proposalId: 'gov_action1eps', title: 'epsilon action', topicId: 'gteps' });
    const body = await handleSearch(db(), 'epsilon', { scope: 'governance', page: 1 });
    expect(body.scope).toBe('governance');
    expect(body.governanceActions).toHaveLength(1);
    expect(body.discussions).toEqual([]);
    expect(body.total).toBe(1);
  });

  it('returns counts when requested and leaves total null for all', async () => {
    await seedTopic({ id: 'f2', title: 'zeta topic', slug: 'f2' });
    const body = await handleSearch(db(), 'zeta', { scope: 'all', counts: true });
    expect(body.counts).not.toBeNull();
    expect(body.counts?.forum).toBe(1);
    expect(body.total).toBeNull();
  });

  it('all page mode keeps groups consistent with facet counts (no discussion inflation)', async () => {
    // A governance action whose own text does NOT match, but a post in its
    // discussion does. The palette folds that into the governance group, the
    // page must not, so the "All" governance group matches counts.governance.
    await seedGa({ id: `${'c'.repeat(64)}#0`, proposalId: 'gov_action1theta', title: 'unrelated title', abstract: null, topicId: 'gttheta' });
    await seedPost({ id: 'ptheta', topicId: 'gttheta', body: 'this post mentions theta clearly' });
    const body = await handleSearch(db(), 'theta', { scope: 'all', counts: true });
    expect(body.counts?.governance).toBe(0);
    expect(body.governanceActions).toHaveLength(0);
  });

  it('all scope keeps grouped results and no counts by default', async () => {
    await seedTopic({ id: 'f3', title: 'omega thread', slug: 'f3' });
    const body = await handleSearch(db(), 'omega');
    expect(body.scope).toBe('all');
    expect(body.discussions.length).toBeGreaterThanOrEqual(1);
    expect(body.counts).toBeNull();
    expect(body.total).toBeNull();
  });

  describe('content scopes', () => {
    // More editions than one page holds, so the reviews scope has to paginate.
    const content = indexContent([
      ...Array.from({ length: PAGE_SIZE + 3 }, (_, i) => ({
        kind: 'reviews' as const,
        title: `Edition ${i + 1}`,
        href: `/governance-review/e${i + 1}/`,
        headings: [],
        text: 'the kappa window',
        order: i + 1,
      })),
      { kind: 'help' as const, title: 'Kappa guide', href: '/help/kappa/', headings: [], text: 'about kappa' },
    ]);

    it('reviews scope paginates the editions and reports their total', async () => {
      const first = await handleSearch(db(), 'kappa', { scope: 'reviews', page: 1, content });
      expect(first.reviews).toHaveLength(PAGE_SIZE);
      expect(first.reviews[0].href).toBe(`/governance-review/e${PAGE_SIZE + 3}/`); // newest first
      expect(first.help).toEqual([]);
      expect(first.total).toBe(PAGE_SIZE + 3);
      const second = await handleSearch(db(), 'kappa', { scope: 'reviews', page: 2, content });
      expect(second.reviews).toHaveLength(3);
    });

    it('facet counts include help and reviews next to the D1 scopes', async () => {
      await seedTopic({ id: 'fk', title: 'kappa thread', slug: 'fk' });
      const body = await handleSearch(db(), 'kappa', { scope: 'help', counts: true, content });
      expect(body.help.map((h) => h.href)).toEqual(['/help/kappa/']);
      expect(body.total).toBe(1);
      expect(body.counts).toEqual({ forum: 1, governance: 0, dreps: 0, rationales: 0, reviews: PAGE_SIZE + 3, help: 1 });
    });

    it('palette mode caps each content group', async () => {
      const body = await handleSearch(db(), 'kappa', { content });
      expect(body.reviews).toHaveLength(5);
      expect(body.help).toHaveLength(1);
    });
  });
});

describe('handleSearch rationales scope', () => {
  it('rationales scope returns only rationales with a total', async () => {
    await seedRationale('ga1', 'raise-cap', 'Raise cap', 'drep1x', 'Xavier', 'Yes', '<p>treasury runway concern</p>');
    const body = await handleSearch(db(), 'treasury', { scope: 'rationales', page: 1 });
    expect(body.scope).toBe('rationales');
    expect(body.rationales).toHaveLength(1);
    expect(body.rationales[0].vote).toBe('Yes');
    expect(body.rationales[0].name).toBe('Xavier');
    expect(body.governanceActions).toEqual([]);
    expect(body.discussions).toEqual([]);
    expect(body.total).toBe(1);
  });

  it('all page mode includes a rationales count', async () => {
    await seedRationale('ga2', 'budget-b', 'Budget B', 'drep1y', 'Yolanda', 'No', '<p>epsilon budget note</p>');
    const body = await handleSearch(db(), 'epsilon', { scope: 'all', counts: true });
    expect(body.counts?.rationales).toBe(1);
    expect(body.rationales.length).toBeGreaterThanOrEqual(1);
    expect(body.total).toBeNull();
  });
});

describe('handleSearch identifier fast-path under a filter', () => {
  it('resolves a pasted CIP-129 DRep id while the dreps filter is active', async () => {
    const hash = new Uint8Array(28).fill(0xab);
    const hex = 'ab'.repeat(28);
    const cip129 = encodeBech32('drep', new Uint8Array([0x22, ...hash]));
    await upsertDrep(db(), drepArgs('drep1stored', 'Stored DRep', hex));

    const body = await handleSearch(db(), cip129, { scope: 'dreps', page: 1, counts: true });
    expect(body.exact).toEqual({ kind: 'drep', href: '/dreps/drep1stored/', label: 'Stored DRep' });
  });

  it('resolves a pasted governance id while the governance filter is active', async () => {
    await seedGa({ id: 'gaid#0', proposalId: 'gov_action1one', title: 'The Action', topicId: 'gt1', slug: 'ga-slug' });

    const body = await handleSearch(db(), 'gov_action1one', { scope: 'governance', page: 1, counts: true });
    expect(body.exact).toEqual({ kind: 'governance-action', href: '/t/ga-slug/', label: 'The Action' });
  });

  it('leaves exact null for free-text scoped queries', async () => {
    const body = await handleSearch(db(), 'treasury runway', { scope: 'dreps', page: 1 });
    expect(body.exact).toBeNull();
  });
});
