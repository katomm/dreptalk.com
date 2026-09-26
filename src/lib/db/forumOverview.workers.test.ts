/// <reference types="@cloudflare/workers-types" />
// Overview-query tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, getCategoryStats } from './forum.js';

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
