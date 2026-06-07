/// <reference types="@cloudflare/workers-types" />
// Overview-query tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createTopic,
  getLatestTopicsAcrossCategories,
  getCategoryStats,
} from './forum.js';

const db = () => env.DB;
const BASE = 1_755_000_000_000;

let seq = 0;
async function topic(categorySlug: string, now: number) {
  seq++;
  const { topic } = await createTopic(db(), {
    categorySlug,
    authorId: `a-${seq}`,
    title: `Topic ${seq}`,
    bodyMd: 'b',
    bodyHtml: '<p>b</p>',
    now,
    rand: `ov${seq}`,
  });
  return topic;
}

describe('getLatestTopicsAcrossCategories', () => {
  it('orders by last activity across categories, newest first', async () => {
    const a = await topic('general', BASE + 1000);
    const b = await topic('budget', BASE + 3000);
    const c = await topic('constitution', BASE + 2000);

    const latest = await getLatestTopicsAcrossCategories(db(), { limit: 10 });
    const idx = (id: string) => latest.findIndex((t) => t.id === id);
    expect(idx(b.id)).toBeLessThan(idx(c.id));
    expect(idx(c.id)).toBeLessThan(idx(a.id));
  });

  it('respects the limit', async () => {
    await topic('general', BASE + 100);
    await topic('budget', BASE + 200);
    const latest = await getLatestTopicsAcrossCategories(db(), { limit: 1 });
    expect(latest.length).toBe(1);
  });
});

describe('getCategoryStats', () => {
  it('counts non-deleted topics and the latest activity per category', async () => {
    await topic('general', BASE + 5000);
    await topic('general', BASE + 6000);
    await topic('budget', BASE + 7000);

    const stats = await getCategoryStats(db());
    expect(stats.get('general')!.topicCount).toBeGreaterThanOrEqual(2);
    expect(stats.get('budget')!.lastPostAt).toBeGreaterThanOrEqual(BASE + 7000);
  });
});
