/// <reference types="@cloudflare/workers-types" />
// Deploy-window resilience: code deploys on merge but D1 migrations are
// applied manually, so /api/search can run before the FTS tables exist. The
// handler must degrade to empty groups, never throw. Own file: it drops the
// FTS tables, and each workers test file gets its own freshly migrated DB.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleSearch } from './handler.js';
import { indexContent } from './content.js';

describe('handleSearch without FTS tables', () => {
  it('returns empty groups instead of throwing', async () => {
    for (const t of ['governance_actions_fts', 'topics_fts', 'posts_fts', 'dreps_fts']) {
      await env.DB.prepare(`DROP TABLE ${t}`).run();
    }
    const r = await handleSearch(env.DB, 'treasury');
    expect(r).toEqual({
      query: 'treasury',
      scope: 'all',
      page: 1,
      exact: null,
      governanceActions: [],
      discussions: [],
      dreps: [],
      rationales: [],
      reviews: [],
      help: [],
      total: null,
      counts: null,
    });

    // The help and Governance Review groups do not depend on D1 and keep
    // answering. Same test: the per-test reset expects the dropped tables.
    const content = indexContent([
      { kind: 'reviews', title: 'Treasury edition', href: '/governance-review/epochs-600-602/', headings: [], text: 'treasury' },
      { kind: 'help', title: 'Treasury guide', href: '/help/treasury/', headings: [], text: 'treasury' },
    ]);
    const withContent = await handleSearch(env.DB, 'treasury', { content });
    expect(withContent.governanceActions).toEqual([]);
    expect(withContent.reviews.map((h) => h.href)).toEqual(['/governance-review/epochs-600-602/']);
    expect(withContent.help.map((h) => h.href)).toEqual(['/help/treasury/']);
    const scoped = await handleSearch(env.DB, 'treasury', { scope: 'reviews', counts: true, content });
    expect(scoped.total).toBe(1);
    // D1 could not count its scopes, so no facet shows a misleading zero.
    expect(scoped.counts).toBeNull();
  });
});
