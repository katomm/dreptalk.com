/// <reference types="@cloudflare/workers-types" />
// Client-facing channel row shaping: what the settings islands may see.
import { describe, it, expect } from 'vitest';
import { endpointFingerprint, toClientChannels } from './channelView.js';
import type { NotificationChannelRow } from '../db/notificationChannels.js';

const row = (over: Partial<NotificationChannelRow>): NotificationChannelRow => ({
  id: 'id-1',
  user_id: 'u',
  channel: 'webpush',
  target: '{"endpoint":"https://push.example/abc","keys":{"p256dh":"p","auth":"a"}}',
  endpoint: 'https://push.example/abc',
  label: null,
  created_at: 100,
  delivered_until: 100,
  ...over,
});

describe('endpointFingerprint', () => {
  it('is 12 lowercase hex chars and deterministic', async () => {
    const a = await endpointFingerprint('https://push.example/abc');
    const b = await endpointFingerprint('https://push.example/abc');
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(b);
    expect(await endpointFingerprint('https://push.example/other')).not.toBe(a);
  });
});

describe('toClientChannels', () => {
  it('exposes only safe fields, fingerprint for webpush, label for telegram', async () => {
    const rows = [
      row({}),
      row({ id: 'id-2', channel: 'telegram', endpoint: 'telegram:555', target: '555', label: '@Ada', delivered_until: 900 }),
    ];
    const out = await toClientChannels(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 'id-1', channel: 'webpush', createdAt: 100, deliveredUntil: 100,
      label: null, fingerprint: await endpointFingerprint('https://push.example/abc'),
    });
    expect(out[1]).toEqual({ id: 'id-2', channel: 'telegram', createdAt: 100, deliveredUntil: 900, label: '@Ada', fingerprint: null });
    for (const c of out) {
      expect(JSON.stringify(c)).not.toContain('push.example');
      expect(JSON.stringify(c)).not.toContain('555');
    }
  });
});
