/// <reference types="@cloudflare/workers-types" />
// One-time Telegram link codes in KV, tested against the real KV binding in
// workerd.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { issueLinkCode, consumeLinkCode } from './telegramLink.js';

const kv = () => (env as { SESSIONS: KVNamespace }).SESSIONS;

describe('telegram link codes', () => {
  it('issues a base64url code that fits the 64-char start payload', async () => {
    const code = await issueLinkCode(kv(), 'user-1');
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code.length).toBeGreaterThanOrEqual(32);
    expect(code.length).toBeLessThanOrEqual(64);
  });

  it('consume resolves the user id exactly once', async () => {
    const code = await issueLinkCode(kv(), 'user-2');
    expect(await consumeLinkCode(kv(), code)).toBe('user-2');
    expect(await consumeLinkCode(kv(), code)).toBeNull();
  });

  it('unknown codes resolve to null', async () => {
    expect(await consumeLinkCode(kv(), 'nope')).toBeNull();
  });
});
