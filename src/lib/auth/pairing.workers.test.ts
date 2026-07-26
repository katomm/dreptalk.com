import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  PAIRING_TTL_SEC,
  createPairing,
  lookupPairing,
  approvePairing,
  pollPairing,
} from './pairing.js';
import { formatPairingCode } from './pairingCode.js';

const db = () => env.DB as D1Database;
const NOW = 1_700_000_000;

beforeEach(async () => {
  await db().prepare('DELETE FROM device_pairings').run();
});

describe('createPairing', () => {
  it('returns distinct opaque values and an expiry one TTL out', async () => {
    const p = await createPairing(db(), { userAgent: 'test-agent', now: NOW });
    expect(p.pairingId).toBeTruthy();
    expect(p.deviceSecret).toBeTruthy();
    expect(p.pairingId).not.toBe(p.deviceSecret);
    expect(p.expiresAt).toBe(NOW + PAIRING_TTL_SEC);
  });

  it('stores neither the code nor the secret in plain text', async () => {
    const p = await createPairing(db(), { userAgent: null, now: NOW });
    const row = await db()
      .prepare('SELECT code_hash, secret_hash FROM device_pairings WHERE pairing_id = ?1')
      .bind(p.pairingId)
      .first<{ code_hash: string; secret_hash: string }>();
    expect(row!.code_hash).not.toBe(p.code);
    expect(row!.secret_hash).not.toBe(p.deviceSecret);
  });

  it('sweeps expired rows on insert', async () => {
    const old = await createPairing(db(), { userAgent: null, now: NOW - PAIRING_TTL_SEC - 1 });
    await createPairing(db(), { userAgent: null, now: NOW });
    const row = await db()
      .prepare('SELECT pairing_id FROM device_pairings WHERE pairing_id = ?1')
      .bind(old.pairingId)
      .first();
    expect(row).toBeNull();
  });
});

describe('lookupPairing', () => {
  it('previews a pending code without approving it', async () => {
    const p = await createPairing(db(), { userAgent: 'Android Chrome', now: NOW });
    const found = await lookupPairing(db(), formatPairingCode(p.code), { now: NOW });
    expect(found).toEqual({ userAgent: 'Android Chrome', createdAt: NOW });

    const status = await db()
      .prepare('SELECT status FROM device_pairings WHERE pairing_id = ?1')
      .bind(p.pairingId)
      .first<{ status: string }>();
    expect(status!.status).toBe('pending');
  });

  it('returns null for unknown and for expired codes alike', async () => {
    const p = await createPairing(db(), { userAgent: null, now: NOW });
    expect(await lookupPairing(db(), 'ZZZZZZZZ', { now: NOW })).toBeNull();
    expect(await lookupPairing(db(), p.code, { now: NOW + PAIRING_TTL_SEC + 1 })).toBeNull();
  });
});

describe('approvePairing', () => {
  it('approves a pending code once and refuses the second attempt', async () => {
    const p = await createPairing(db(), { userAgent: null, now: NOW });
    expect(await approvePairing(db(), p.code, 'user-1', { now: NOW })).toBe(true);
    expect(await approvePairing(db(), p.code, 'user-2', { now: NOW })).toBe(false);

    const row = await db()
      .prepare('SELECT status, user_id FROM device_pairings WHERE pairing_id = ?1')
      .bind(p.pairingId)
      .first<{ status: string; user_id: string }>();
    expect(row!.status).toBe('approved');
    expect(row!.user_id).toBe('user-1');
  });

  it('accepts the formatted code the phone displays', async () => {
    const p = await createPairing(db(), { userAgent: null, now: NOW });
    expect(await approvePairing(db(), formatPairingCode(p.code), 'user-1', { now: NOW })).toBe(true);
  });

  it('refuses an expired code', async () => {
    const p = await createPairing(db(), { userAgent: null, now: NOW });
    const later = NOW + PAIRING_TTL_SEC + 1;
    expect(await approvePairing(db(), p.code, 'user-1', { now: later })).toBe(false);
  });

  it('refuses a malformed code without touching the table', async () => {
    expect(await approvePairing(db(), 'not-a-code', 'user-1', { now: NOW })).toBe(false);
  });
});

describe('pollPairing', () => {
  it('reports pending before approval', async () => {
    const p = await createPairing(db(), { userAgent: null, now: NOW });
    expect(await pollPairing(db(), p.pairingId, p.deviceSecret, { now: NOW })).toEqual({
      status: 'pending',
    });
  });

  it('claims an approved pairing exactly once', async () => {
    const p = await createPairing(db(), { userAgent: null, now: NOW });
    await approvePairing(db(), p.code, 'user-1', { now: NOW });

    const first = await pollPairing(db(), p.pairingId, p.deviceSecret, { now: NOW });
    expect(first).toEqual({ status: 'consumed', userId: 'user-1' });

    const second = await pollPairing(db(), p.pairingId, p.deviceSecret, { now: NOW });
    expect(second).toEqual({ status: 'unknown' });
  });

  it('refuses a wrong secret', async () => {
    const p = await createPairing(db(), { userAgent: null, now: NOW });
    await approvePairing(db(), p.code, 'user-1', { now: NOW });
    expect(await pollPairing(db(), p.pairingId, 'wrong-secret', { now: NOW })).toEqual({
      status: 'unknown',
    });
  });

  it('refuses the stored secret hash presented as the secret', async () => {
    // This is the specific regression the corrected protocol exists to prevent:
    // the value in the database must never be accepted as the credential.
    const p = await createPairing(db(), { userAgent: null, now: NOW });
    await approvePairing(db(), p.code, 'user-1', { now: NOW });
    const row = await db()
      .prepare('SELECT secret_hash FROM device_pairings WHERE pairing_id = ?1')
      .bind(p.pairingId)
      .first<{ secret_hash: string }>();

    expect(await pollPairing(db(), p.pairingId, row!.secret_hash, { now: NOW })).toEqual({
      status: 'unknown',
    });
  });

  it('refuses an unknown pairing id and an expired record alike', async () => {
    const p = await createPairing(db(), { userAgent: null, now: NOW });
    await approvePairing(db(), p.code, 'user-1', { now: NOW });
    expect(await pollPairing(db(), 'no-such-id', p.deviceSecret, { now: NOW })).toEqual({
      status: 'unknown',
    });
    const later = NOW + PAIRING_TTL_SEC + 1;
    expect(await pollPairing(db(), p.pairingId, p.deviceSecret, { now: later })).toEqual({
      status: 'unknown',
    });
  });
});
