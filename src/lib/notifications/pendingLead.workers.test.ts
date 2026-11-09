/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { addChannel, getPrefs, listChannels } from '../db/notificationChannels.js';
import { insertGroupNotifications } from '../db/groupNotifications.js';
import { resolvePendingLead } from './pendingLead.js';

const db = () => env.DB as D1Database;

describe('resolvePendingLead for group notifications', () => {
  it('renders a lead for a group notification without a topic', async () => {
    await addChannel(db(), { userId: 'gl_user', channel: 'webpush', target: 't', endpoint: 'https://push.example/gl' });
    const [channel] = await listChannels(db(), 'gl_user');
    const prefs = await getPrefs(db(), 'gl_user', 'webpush');
    await insertGroupNotifications(db(), [
      { recipientId: 'gl_user', type: 'group_join_request', eventKey: 'group-join:x', payload: { groupId: 'g1', groupName: 'Example Council', memberName: 'Carol' } },
    ]);
    const lead = await resolvePendingLead(db(), { ...channel, delivered_until: 0 }, prefs, Number.MAX_SAFE_INTEGER);
    expect(lead?.title).toBe('Carol asked to join Example Council');
    expect(lead?.href).toBe('/groups/g1/#requests');

    expect(await resolvePendingLead(db(), { ...channel, delivered_until: 0 }, { ...prefs, drep_groups: false }, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it('links a signature request to its sign page', async () => {
    await addChannel(db(), { userId: 'gl_signer', channel: 'webpush', target: 't', endpoint: 'https://push.example/gls' });
    const [channel] = await listChannels(db(), 'gl_signer');
    const prefs = await getPrefs(db(), 'gl_signer', 'webpush');
    await insertGroupNotifications(db(), [
      { recipientId: 'gl_signer', type: 'group_signature_request', eventKey: 'group-sign:r1', payload: { groupId: 'g1', groupName: 'Example Council', memberName: 'Alice', actionId: 'r1', summary: 'Approve Carol' } },
    ]);
    const lead = await resolvePendingLead(db(), { ...channel, delivered_until: 0 }, prefs, Number.MAX_SAFE_INTEGER);
    expect(lead?.title).toBe('Alice asked you to sign for Example Council: Approve Carol');
    expect(lead?.href).toBe('/groups/sign/r1/');
  });
});
