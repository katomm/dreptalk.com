// Single-use nonce tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// env.NONCES is the real KV binding provided by miniflare.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { issueNonce, consumeNonce } from './nonce.js';

const kv = () => env.NONCES;

describe('issueNonce', () => {
  it('returns a nonce and a correctly formatted payload', async () => {
    const { nonce, payload } = await issueNonce(kv(), { domain: 'example.com' });
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBeGreaterThan(0);
    expect(payload).toMatch(/^dreptalk:example\.com:[^:]+:\d+$/);
    expect(payload).toContain(`:${nonce}:`);
  });

  it('stores the nonce in KV retrievable by key', async () => {
    const { nonce, payload } = await issueNonce(kv(), { domain: 'example.com' });
    const stored = await kv().get(nonce);
    expect(stored).toBe(payload);
  });

  it('uses the provided now value for issuedAt', async () => {
    const fixedNow = 1_700_000_000;
    const { payload } = await issueNonce(kv(), { domain: 'test.io', now: fixedNow });
    expect(payload.endsWith(`:${fixedNow}`)).toBe(true);
  });
});

describe('consumeNonce', () => {
  it('returns true and deletes the key on first consume', async () => {
    const { nonce, payload } = await issueNonce(kv(), { domain: 'example.com' });
    const result = await consumeNonce(kv(), payload);
    expect(result).toBe(true);
    // Key must be gone after consume (single-use enforcement).
    const remaining = await kv().get(nonce);
    expect(remaining).toBeNull();
  });

  it('returns false on second consume (replay rejection)', async () => {
    const { payload } = await issueNonce(kv(), { domain: 'example.com' });
    const first = await consumeNonce(kv(), payload);
    expect(first).toBe(true);
    const second = await consumeNonce(kv(), payload);
    expect(second).toBe(false);
  });

  it('returns false for a tampered payload (different domain)', async () => {
    const { nonce, payload } = await issueNonce(kv(), { domain: 'legit.com' });
    // Replace domain in payload to simulate a cross-domain replay attempt.
    const tampered = payload.replace('dreptalk:legit.com:', 'dreptalk:evil.com:');
    const result = await consumeNonce(kv(), tampered);
    expect(result).toBe(false);
    // Original key should still be present since the tampered lookup failed.
    const stored = await kv().get(nonce);
    expect(stored).not.toBeNull();
  });

  it('returns false for a tampered payload (different nonce in key lookup)', async () => {
    // Issue a nonce; build a payload referencing a different nonce string.
    const { payload } = await issueNonce(kv(), { domain: 'a.com' });
    const parts = payload.split(':');
    // Flip one character in the nonce segment (index from end: issuedAt=last, nonce=second-last).
    const nonceIdx = parts.length - 2;
    parts[nonceIdx] = parts[nonceIdx].slice(0, -1) + (parts[nonceIdx].endsWith('A') ? 'B' : 'A');
    const tampered = parts.join(':');
    const result = await consumeNonce(kv(), tampered);
    expect(result).toBe(false);
  });

  it('returns false when issuedAt is older than maxAgeSec', async () => {
    const issuedAt = 1_700_000_000;
    const { payload } = await issueNonce(kv(), { domain: 'example.com', now: issuedAt });
    // Present the payload 301 seconds later.
    const result = await consumeNonce(kv(), payload, { now: issuedAt + 301, maxAgeSec: 300 });
    expect(result).toBe(false);
  });

  it('returns false when issuedAt is in the future relative to now', async () => {
    const now = 1_700_000_000;
    const { payload } = await issueNonce(kv(), { domain: 'example.com', now: now + 60 });
    // Verify with a now value before the issuedAt.
    const result = await consumeNonce(kv(), payload, { now });
    expect(result).toBe(false);
  });

  it('returns false for a malformed payload (not enough segments)', async () => {
    expect(await consumeNonce(kv(), 'not-a-valid-payload')).toBe(false);
    expect(await consumeNonce(kv(), '')).toBe(false);
    expect(await consumeNonce(kv(), 'dreptalk:only-two-parts')).toBe(false);
  });

  it('returns false for a payload with wrong prefix', async () => {
    const { payload } = await issueNonce(kv(), { domain: 'example.com' });
    const wrongPrefix = 'othertalk' + payload.slice('dreptalk'.length);
    expect(await consumeNonce(kv(), wrongPrefix)).toBe(false);
  });
});
