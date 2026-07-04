/// <reference types="@cloudflare/workers-types" />
// Deploy-window resilience: code deploys on merge but D1 migrations are
// applied manually, so /api/search can run before the FTS tables exist. The
// handler must degrade to empty groups, never throw. Own file: it drops the
// FTS tables, and each workers test file gets its own freshly migrated DB.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleSearch } from './handler.js';

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
      total: null,
      counts: null,
    });
  });
});
