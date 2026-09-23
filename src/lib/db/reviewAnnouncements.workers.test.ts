/// <reference types="@cloudflare/workers-types" />
// Governance Review announcement tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { announceLatestEdition, parseReviewPayload } from './reviewAnnouncements.js';

const db = () => env.DB;

const ed = (edition: number) => ({
  edition,
  slug: `epochs-${edition * 3}-${edition * 3 + 2}`,
  title: `Edition ${edition} title`,
});

async function rows() {
  const { results } = await db()
    .prepare('SELECT edition, announced_at FROM review_announcements ORDER BY edition')
    .all<{ edition: number; announced_at: number }>();
  return results;
}

describe('announceLatestEdition', () => {
  it('seeds the first edition silently, with announced_at 0', async () => {
    expect(await announceLatestEdition(db(), ed(42), 5_000)).toBe('seeded');
    expect(await rows()).toEqual([{ edition: 42, announced_at: 0 }]);
  });

  it('announces an edition newer than the last one at the given time', async () => {
    await announceLatestEdition(db(), ed(42), 5_000);
    expect(await announceLatestEdition(db(), ed(43), 9_000)).toBe('announced');
    expect(await rows()).toEqual([
      { edition: 42, announced_at: 0 },
      { edition: 43, announced_at: 9_000 },
    ]);
  });

  it('does nothing for the same edition again (a revision or a later run)', async () => {
    await announceLatestEdition(db(), ed(42), 5_000);
    await announceLatestEdition(db(), ed(43), 9_000);
    expect(await announceLatestEdition(db(), { ...ed(43), title: 'Revised title' }, 12_000)).toBe('none');
    expect(await rows()).toEqual([
      { edition: 42, announced_at: 0 },
      { edition: 43, announced_at: 9_000 },
    ]);
  });

  it('never announces an older edition (a backfill merge)', async () => {
    await announceLatestEdition(db(), ed(42), 5_000);
    expect(await announceLatestEdition(db(), ed(7), 9_000)).toBe('none');
    expect(await rows()).toEqual([{ edition: 42, announced_at: 0 }]);
  });

  it('jumping several editions at once announces only the newest one', async () => {
    await announceLatestEdition(db(), ed(42), 5_000);
    expect(await announceLatestEdition(db(), ed(45), 9_000)).toBe('announced');
    expect((await rows()).map((r) => r.edition)).toEqual([42, 45]);
  });

  it('two overlapping runs announce an edition only once', async () => {
    await announceLatestEdition(db(), ed(42), 5_000);
    const [a, b] = await Promise.all([
      announceLatestEdition(db(), ed(43), 9_000),
      announceLatestEdition(db(), ed(43), 9_001),
    ]);
    expect([a, b].filter((r) => r === 'announced').length).toBeLessThanOrEqual(1);
    expect((await rows()).filter((r) => r.edition === 43).length).toBe(1);
  });
});

describe('notification fan-out', () => {
  async function seedUser(id: string) {
    await db().prepare('INSERT INTO users (id, created_at, last_verified_at) VALUES (?, 1, 1)').bind(id).run();
  }
  async function reviewRows() {
    const { results } = await db()
      .prepare(
        `SELECT recipient_id, event_key, payload, created_at FROM notifications
          WHERE type = 'review_published' ORDER BY recipient_id`,
      )
      .all<{ recipient_id: string; event_key: string; payload: string; created_at: number }>();
    return results;
  }

  it('the silent seed notifies nobody', async () => {
    await seedUser('alice');
    await announceLatestEdition(db(), ed(42), 5_000);
    expect(await reviewRows()).toEqual([]);
  });

  it('a new edition writes one row per account, never for the built-in system user', async () => {
    await seedUser('alice');
    await seedUser('bob');
    await announceLatestEdition(db(), ed(42), 5_000);
    await announceLatestEdition(db(), ed(43), 9_000);
    const rows = await reviewRows();
    expect(rows.map((r) => r.recipient_id)).toEqual(['alice', 'bob']);
    expect(rows[0]).toMatchObject({ event_key: 'review:43', created_at: 9_000 });
    expect(parseReviewPayload(rows[0].payload)).toEqual(ed(43));
  });

  it('two overlapping runs notify each account once', async () => {
    await seedUser('alice');
    await announceLatestEdition(db(), ed(42), 5_000);
    await Promise.all([announceLatestEdition(db(), ed(43), 9_000), announceLatestEdition(db(), ed(43), 9_001)]);
    expect((await reviewRows()).length).toBe(1);
  });
});

describe('parseReviewPayload', () => {
  it('rejects null, garbage and wrong types', () => {
    expect(parseReviewPayload(null)).toBeNull();
    expect(parseReviewPayload('{')).toBeNull();
    expect(parseReviewPayload(JSON.stringify({ edition: '43', slug: 's', title: 't' }))).toBeNull();
  });
});
