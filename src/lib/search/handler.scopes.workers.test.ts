/// <reference types="@cloudflare/workers-types" />
// Scoped handler behaviour: one group per scope, totals, and facet counts.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleSearch } from './handler.js';
import { indexContent } from './content.js';
import { PAGE_SIZE } from './scopes.js';

const db = () => env.DB;
const NOW = 1_749_000_000_000;

async function seedTopic(o: { id: string; title: string; slug: string; source?: 'user' | 'governance' }) {
  await db()
    .prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
       VALUES (?, 'general', 'system', ?, ?, ?, 1, ?, ?, 0)`,
    )
    .bind(o.id, o.source ?? 'user', o.title, o.slug, NOW, NOW)
    .run();
}

async function seedGa(o: { id: string; proposalId: string; title: string; topicId: string; abstract?: string | null }) {
  await seedTopic({ id: o.topicId, title: o.title, slug: `s-${o.topicId}`, source: 'governance' });
  await db()
    .prepare(
      `INSERT INTO governance_actions (id, proposal_id, type, title, abstract, status, topic_id, created_at, last_synced_at)
       VALUES (?, ?, 'InfoAction', ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(o.id, o.proposalId, o.title, o.abstract ?? null, o.topicId, NOW, NOW)
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
    // discussion does. The palette folds that into the governance group; the
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
