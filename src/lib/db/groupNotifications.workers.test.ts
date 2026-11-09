/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { insertGroupNotifications, groupNotificationStatements, type GroupNotification } from './groupNotifications.js';

const db = () => env.DB as D1Database;

function row(i: number, recipientId = 'gn_alice'): GroupNotification {
  return {
    recipientId,
    type: 'group_join_request',
    eventKey: `group-join:${recipientId}:${i}`,
    payload: { groupId: 'g1', groupName: 'Example Council', memberName: 'Carol' },
  };
}

describe('insertGroupNotifications', () => {
  it('inserts a group notification once per event key', async () => {
    const rows = [row(1), { ...row(2), type: 'group_signature_request' as const, payload: { groupId: 'g1', groupName: null, actionId: 'a1', summary: 'Approve Carol' } }];
    await insertGroupNotifications(db(), rows);
    await insertGroupNotifications(db(), rows);
    const { results } = await db()
      .prepare("SELECT type, event_key, payload FROM notifications WHERE recipient_id = 'gn_alice' ORDER BY event_key")
      .all<{ type: string; event_key: string; payload: string }>();
    expect(results.map((r) => r.type)).toEqual(['group_join_request', 'group_signature_request']);
    expect(JSON.parse(results[1].payload).summary).toBe('Approve Carol');
  });

  it('chunks under the bind limit and handles an empty list', async () => {
    const rows = Array.from({ length: 45 }, (_, i) => row(i, 'gn_bulk'));
    expect(groupNotificationStatements(db(), rows)).toHaveLength(3);
    await insertGroupNotifications(db(), []);
    await insertGroupNotifications(db(), rows);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = 'gn_bulk'").first<{ n: number }>();
    expect(n?.n).toBe(45);
  });
});
