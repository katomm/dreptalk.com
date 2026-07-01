// Single-use nonce tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Nonces live in D1 (env.DB); the auth_nonces migration is applied by the pool.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { issueNonce, consumeNonce } from './nonce.js';

const db = () => env.DB as D1Database;

async function rowExists(nonce: string): Promise<boolean> {
  const row = await db().prepare('SELECT nonce FROM auth_nonces WHERE nonce = ?1').bind(nonce).first();
  return row !== null;
}

describe('issueNonce', () => {
  it('returns a nonce and a correctly formatted payload', async () => {
    const { nonce, payload } = await issueNonce(db(), { domain: 'example.com' });
    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBeGreaterThan(0);
    expect(payload).toMatch(/^dreptalk:example\.com:[^:]+:\d+$/);
    expect(payload).toContain(`:${nonce}:`);
  });

  it('stores the nonce in D1 retrievable by key', async () => {
    const { nonce, payload } = await issueNonce(db(), { domain: 'example.com' });
    const row = await db()
      .prepare('SELECT payload FROM auth_nonces WHERE nonce = ?1')
      .bind(nonce)
      .first<{ payload: string }>();
    expect(row?.payload).toBe(payload);
  });

  it('uses the provided now value for issuedAt', async () => {
    const fixedNow = 1_700_000_000;
    const { payload } = await issueNonce(db(), { domain: 'test.io', now: fixedNow });
    expect(payload.endsWith(`:${fixedNow}`)).toBe(true);
  });
});

describe('consumeNonce', () => {
  it('returns true and deletes the row on first consume', async () => {
    const { nonce, payload } = await issueNonce(db(), { domain: 'example.com' });
    const result = await consumeNonce(db(), payload);
    expect(result).toBe(true);
    // Row must be gone after consume (single-use enforcement).
    expect(await rowExists(nonce)).toBe(false);
  });

  it('returns false on second consume (replay rejection)', async () => {
    const { payload } = await issueNonce(db(), { domain: 'example.com' });
    expect(await consumeNonce(db(), payload)).toBe(true);
    expect(await consumeNonce(db(), payload)).toBe(false);
  });

  it('consumes atomically: only one of two concurrent consumes wins', async () => {
    // The whole point of moving off KV: a concurrent double-submit of one signed
    // payload must be accepted at most once. SQLite serializes the DELETE, so
    // exactly one of the two racing consumes returns true.
    const { payload } = await issueNonce(db(), { domain: 'race.com' });
    const [a, b] = await Promise.all([consumeNonce(db(), payload), consumeNonce(db(), payload)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('returns false for a tampered payload (different domain), leaving the row', async () => {
    const { nonce, payload } = await issueNonce(db(), { domain: 'legit.com' });
    // Replace domain in payload to simulate a cross-domain replay attempt.
    const tampered = payload.replace('dreptalk:legit.com:', 'dreptalk:evil.com:');
    expect(await consumeNonce(db(), tampered)).toBe(false);
    // Original row must still be present since the tampered payload matched nothing.
    expect(await rowExists(nonce)).toBe(true);
  });

  it('returns false for a tampered payload (different nonce in key lookup)', async () => {
    const { payload } = await issueNonce(db(), { domain: 'a.com' });
    const parts = payload.split(':');
    // Flip one character in the nonce segment (issuedAt=last, nonce=second-last).
    const nonceIdx = parts.length - 2;
    parts[nonceIdx] = parts[nonceIdx].slice(0, -1) + (parts[nonceIdx].endsWith('A') ? 'B' : 'A');
    expect(await consumeNonce(db(), parts.join(':'))).toBe(false);
  });

  it('returns false when issuedAt is older than maxAgeSec', async () => {
    const issuedAt = 1_700_000_000;
    const { payload } = await issueNonce(db(), { domain: 'example.com', now: issuedAt });
    // Present the payload 301 seconds later.
    expect(await consumeNonce(db(), payload, { now: issuedAt + 301, maxAgeSec: 300 })).toBe(false);
  });

  it('returns false when issuedAt is in the future relative to now', async () => {
    const now = 1_700_000_000;
    const { payload } = await issueNonce(db(), { domain: 'example.com', now: now + 60 });
    expect(await consumeNonce(db(), payload, { now })).toBe(false);
  });

  it('returns false for a malformed payload (not enough segments)', async () => {
    expect(await consumeNonce(db(), 'not-a-valid-payload')).toBe(false);
    expect(await consumeNonce(db(), '')).toBe(false);
    expect(await consumeNonce(db(), 'dreptalk:only-two-parts')).toBe(false);
  });

  it('returns false for a payload with wrong prefix', async () => {
    const { payload } = await issueNonce(db(), { domain: 'example.com' });
    const wrongPrefix = `othertalk${payload.slice('dreptalk'.length)}`;
    expect(await consumeNonce(db(), wrongPrefix)).toBe(false);
  });

  it('returns false when issuedAt segment is non-numeric, leaving the row', async () => {
    const { nonce, payload } = await issueNonce(db(), { domain: 'example.com' });
    // Replace the trailing numeric issuedAt with a non-numeric string.
    const parts = payload.split(':');
    parts[parts.length - 1] = 'not-a-number';
    expect(await consumeNonce(db(), parts.join(':'))).toBe(false);
    // Original nonce must still be present (no deletion occurred).
    expect(await rowExists(nonce)).toBe(true);
  });
});
