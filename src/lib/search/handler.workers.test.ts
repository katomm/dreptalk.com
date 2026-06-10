/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleSearch } from './handler.js';

const db = () => env.DB;
const NOW = 1_749_000_000_000;
const GA1 = `${'b'.repeat(64)}#0`;

async function seedGaWithTopic() {
  await db()
    .prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at)
       VALUES ('gt1', 'governance-actions', 'system', 'governance', 'Budget action', 'budget-action', 1, ?, ?)`,
    )
    .bind(NOW, NOW)
    .run();
  await db()
    .prepare(
      `INSERT INTO governance_actions (id, proposal_id, type, title, abstract, status, topic_id, created_at, last_synced_at)
       VALUES (?, 'gov_action1budget', 'InfoAction', 'Budget action', 'Spend wisely.', 'active', 'gt1', ?, ?)`,
    )
    .bind(GA1, NOW, NOW)
    .run();
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
    await seedGaWithTopic();
    const r = await handleSearch(db(), 'gov_action1budget');
    expect(r.exact).toEqual({ kind: 'governance-action', href: '/t/budget-action', label: 'Budget action' });
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
    await seedGaWithTopic();
    const r = await handleSearch(db(), 'budget');
    expect(r.exact).toBeNull();
    expect(r.governanceActions).toHaveLength(1);
    expect(r.governanceActions[0].href).toBe('/t/budget-action');
  });
});
