/// <reference types="@cloudflare/workers-types" />
// Subscribe block state tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { loadSubscribeState } from './subscribeState.js';
import { addChannel, setPref } from '../db/notificationChannels.js';

const db = () => env.DB;

const push = (userId: string) =>
  addChannel(db(), { userId, channel: 'webpush', target: '{}', endpoint: `https://push.example/${userId}`, now: 1 });
const telegram = (userId: string) =>
  addChannel(db(), { userId, channel: 'telegram', target: '42', endpoint: `telegram:${userId}`, now: 1 });

describe('loadSubscribeState', () => {
  it('is anonymous without a user', async () => {
    expect(await loadSubscribeState(db(), null, 'governance_review')).toBe('anonymous');
  });

  it('is no_channel for a user without push or Telegram', async () => {
    expect(await loadSubscribeState(db(), 'alice', 'governance_review')).toBe('no_channel');
  });

  it('is on when a connected channel has the event enabled (the default)', async () => {
    await push('alice');
    expect(await loadSubscribeState(db(), 'alice', 'governance_review')).toBe('on');
  });

  it('is on when one of two channel kinds still has it enabled', async () => {
    await push('alice');
    await telegram('alice');
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'governance_review', enabled: false });
    expect(await loadSubscribeState(db(), 'alice', 'governance_review')).toBe('on');
  });

  it('is off when every connected channel has it disabled', async () => {
    await push('alice');
    await setPref(db(), { userId: 'alice', channel: 'webpush', eventType: 'governance_review', enabled: false });
    // A disabled pref on an unconnected kind does not matter either way.
    await setPref(db(), { userId: 'alice', channel: 'telegram', eventType: 'governance_review', enabled: true });
    expect(await loadSubscribeState(db(), 'alice', 'governance_review')).toBe('off');
  });

  it('falls back to no_channel without a database', async () => {
    expect(await loadSubscribeState(undefined, 'alice', 'governance_review')).toBe('no_channel');
  });
});
