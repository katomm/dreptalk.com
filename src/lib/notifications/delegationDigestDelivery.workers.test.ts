/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { addChannel, getPendingCounts, getPrefs, listChannels, setPref } from '../db/notificationChannels.js';
import { resolvePendingLead } from './pendingLead.js';
import { formatNotification } from './pushMessage.js';
import { seedNotificationRow, setChannelCursor } from '../db/__tests__/notificationSeed.js';

const db = () => env.DB as D1Database;
const payload = { epoch: 612, drepId: 'drep1xyz', votes: 2, withRationale: 1, titles: ['A', 'B'], openUnvoted: 1 };

async function seed(userId: string) {
  await db().prepare('INSERT INTO users (id, created_at, last_verified_at) VALUES (?, 0, 0)').bind(userId).run();
  await seedNotificationRow(db(), { recipientId: userId, type: 'delegation_digest', createdAt: 100, payload });
  const ch = await addChannel(db(), { userId, channel: 'telegram', target: `chat_${userId}`, endpoint: `telegram:chat_${userId}` });
  await setChannelCursor(db(), ch, 0);
  return (await listChannels(db(), userId))[0];
}

describe('delegation digest delivery', () => {
  it('counts, leads and formats a pending digest', async () => {
    const row = await seed('dd_a');
    const prefs = await getPrefs(db(), 'dd_a', 'telegram');
    const counts = await getPendingCounts(db(), row, prefs, 1000);
    expect(counts.delegationDigest).toBe(1);
    const lead = await resolvePendingLead(db(), row, prefs, 1000);
    expect(lead?.title).toBe('Epoch 612 · Your DRep');
    expect(lead?.body).toBe('Voted on 2 actions, 1 with a rationale. 1 open action without a vote');
    expect(lead?.href.startsWith('/dreps/')).toBe(true);
    expect(formatNotification(counts, lead).title).toBe('Epoch 612 · Your DRep');
  });

  it('respects the pref for push and Telegram', async () => {
    const row = await seed('dd_b');
    await setPref(db(), { userId: 'dd_b', channel: 'telegram', eventType: 'delegation_digest', enabled: false });
    const prefs = await getPrefs(db(), 'dd_b', 'telegram');
    expect((await getPendingCounts(db(), row, prefs, 1000)).total).toBe(0);
  });

  it('falls back to the count summary for a corrupted payload', async () => {
    const row = await seed('dd_c');
    await db().prepare(`UPDATE notifications SET payload = '{' WHERE recipient_id = 'dd_c'`).run();
    const prefs = await getPrefs(db(), 'dd_c', 'telegram');
    expect(await resolvePendingLead(db(), row, prefs, 1000)).toBeNull();
  });
});
