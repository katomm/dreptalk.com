/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { pruneNotifications } from './notificationRetention.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2027, 0, 1);

async function seed(id: string, ageDays: number, read: boolean) {
  await env.DB.prepare('INSERT INTO notifications (id, recipient_id, type, created_at, read_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, 'u', 'reply', NOW - ageDays * DAY, read ? NOW - ageDays * DAY + 1 : null)
    .run();
}

async function ids() {
  const { results } = await env.DB.prepare('SELECT id FROM notifications ORDER BY id').all<{ id: string }>();
  return results.map((r) => r.id);
}

describe('pruneNotifications', () => {
  it('deletes read rows past 90 days and every row past 365 days', async () => {
    await seed('read-91', 91, true);
    await seed('unread-366', 366, false);
    await seed('unread-91', 91, false);
    await seed('read-89', 89, true);
    const r = await pruneNotifications(env.DB, NOW);
    expect(r.deleted).toBe(2);
    expect(await ids()).toEqual(['read-89', 'unread-91']);
  });

  it('keeps rows exactly at the boundaries', async () => {
    await seed('read-90', 90, true);
    await seed('unread-365', 365, false);
    await pruneNotifications(env.DB, NOW);
    expect(await ids()).toEqual(['read-90', 'unread-365']);
  });

  it('works in batches and stops at the batch cap', async () => {
    for (let i = 0; i < 7; i++) await seed(`old-${i}`, 400, false);
    const r = await pruneNotifications(env.DB, NOW, { batch: 2, maxBatches: 3 });
    expect(r.deleted).toBe(6);
    expect(r.batches).toBe(3);
    expect(r.capped).toBe(true);
    const rest = await pruneNotifications(env.DB, NOW, { batch: 2, maxBatches: 3 });
    expect(rest.deleted).toBe(1);
    expect(rest.capped).toBe(false);
  });
});
