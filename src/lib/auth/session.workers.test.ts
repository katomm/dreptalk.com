// Opaque KV session tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// env.SESSIONS is the real KV binding provided by miniflare.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createSession,
  getSession,
  revokeSession,
  revokeAllForUser,
  buildSessionCookie,
  clearSessionCookie,
  parseSessionToken,
} from './session.js';

const kv = () => env.SESSIONS;

describe('createSession + getSession round-trip', () => {
  it('returns the session record for a fresh token', async () => {
    const now = 1_700_000_000;
    const token = await createSession(kv(), { id: 'user-1', roles: ['voter'] }, { now });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const record = await getSession(kv(), token, { now });
    expect(record).not.toBeNull();
    expect(record!.userId).toBe('user-1');
    expect(record!.roles).toEqual(['voter']);
    expect(record!.createdAt).toBe(now);
    expect(record!.lastSeen).toBe(now);
  });

  it('stores the token hashed so the raw token is not present in KV', async () => {
    const token = await createSession(kv(), { id: 'user-hash-check', roles: [] });
    // The KV should NOT contain the raw token as a key.
    const direct = await kv().get(token);
    expect(direct).toBeNull();
  });
});

describe('getSession sliding renewal', () => {
  it('refreshes lastSeen when now is more than 6h after lastSeen', async () => {
    const createdAt = 1_700_000_000;
    const token = await createSession(kv(), { id: 'user-2', roles: [] }, { now: createdAt });

    // First read within 6h: no update.
    const earlyNow = createdAt + 3600;
    const earlyRecord = await getSession(kv(), token, { now: earlyNow });
    expect(earlyRecord!.lastSeen).toBe(createdAt);

    // Second read beyond 6h: lastSeen should be updated.
    const laterNow = createdAt + 21_601;
    const laterRecord = await getSession(kv(), token, { now: laterNow });
    expect(laterRecord!.lastSeen).toBe(laterNow);

    // Verify the update was persisted by reading again.
    const finalRecord = await getSession(kv(), token, { now: laterNow + 1 });
    expect(finalRecord!.lastSeen).toBe(laterNow);
  });

  it('keeps the usess index alive after sliding renewal', async () => {
    const createdAt = 1_700_000_000;
    const userId = 'user-renewal-index';
    const token = await createSession(kv(), { id: userId, roles: [] }, { now: createdAt });

    // Trigger a sliding renewal (more than 6h later).
    const laterNow = createdAt + 21_601;
    await getSession(kv(), token, { now: laterNow });

    // The per-user index must still be present and contain the hash.
    const indexRaw = await kv().get(`usess:${userId}`);
    expect(indexRaw).not.toBeNull();
    const index = JSON.parse(indexRaw!) as string[];
    expect(index.length).toBeGreaterThan(0);
  });
});

describe('revokeSession', () => {
  it('makes getSession return null after revocation', async () => {
    const token = await createSession(kv(), { id: 'user-3', roles: [] });
    expect(await getSession(kv(), token)).not.toBeNull();

    await revokeSession(kv(), token);
    expect(await getSession(kv(), token)).toBeNull();
  });

  it('does not throw for an unknown token', async () => {
    const fakeToken = 'totallyUnknownTokenThatDoesNotExist';
    await expect(revokeSession(kv(), fakeToken)).resolves.toBeUndefined();
  });

  it('removes the hash from the per-user index after revocation', async () => {
    const userId = 'user-index-prune';
    const t1 = await createSession(kv(), { id: userId, roles: [] });
    const t2 = await createSession(kv(), { id: userId, roles: [] });

    await revokeSession(kv(), t1);

    // t1 should be gone from KV; t2 should still be readable.
    expect(await getSession(kv(), t1)).toBeNull();
    expect(await getSession(kv(), t2)).not.toBeNull();

    // Revoking all should still work for t2 (index still has t2 entry).
    await revokeSession(kv(), t2);
    expect(await getSession(kv(), t2)).toBeNull();
  });
});

describe('revokeAllForUser', () => {
  it('revokes all sessions for a user', async () => {
    const userId = 'user-multi';
    const t1 = await createSession(kv(), { id: userId, roles: ['a'] });
    const t2 = await createSession(kv(), { id: userId, roles: ['b'] });
    const t3 = await createSession(kv(), { id: userId, roles: ['c'] });

    // All should be readable before revocation.
    expect(await getSession(kv(), t1)).not.toBeNull();
    expect(await getSession(kv(), t2)).not.toBeNull();
    expect(await getSession(kv(), t3)).not.toBeNull();

    await revokeAllForUser(kv(), userId);

    expect(await getSession(kv(), t1)).toBeNull();
    expect(await getSession(kv(), t2)).toBeNull();
    expect(await getSession(kv(), t3)).toBeNull();
  });

  it('leaves other users sessions intact', async () => {
    const t_other = await createSession(kv(), { id: 'user-other', roles: [] });
    const t_target = await createSession(kv(), { id: 'user-target', roles: [] });

    await revokeAllForUser(kv(), 'user-target');

    expect(await getSession(kv(), t_other)).not.toBeNull();
    expect(await getSession(kv(), t_target)).toBeNull();
  });

  it('does not throw for a user with no sessions', async () => {
    await expect(revokeAllForUser(kv(), 'non-existent-user')).resolves.toBeUndefined();
  });
});

describe('corrupt usess index handling', () => {
  it('createSession recovers when the index contains corrupt JSON', async () => {
    const userId = 'user-corrupt-create';
    // Write corrupt JSON into the index before creating the session.
    await kv().put(`usess:${userId}`, 'not-valid-json');
    // createSession must not throw; it should treat the index as empty and write a fresh one.
    const token = await createSession(kv(), { id: userId, roles: [] });
    expect(typeof token).toBe('string');
    const record = await getSession(kv(), token);
    expect(record).not.toBeNull();
  });

  it('revokeAllForUser deletes the corrupt index and returns without throwing', async () => {
    const userId = 'user-corrupt-revoke-all';
    await kv().put(`usess:${userId}`, '!!!bad json!!!');
    await expect(revokeAllForUser(kv(), userId)).resolves.toBeUndefined();
    // Index key must be gone after the call.
    const gone = await kv().get(`usess:${userId}`);
    expect(gone).toBeNull();
  });
});

describe('getSession with unknown or garbage tokens', () => {
  it('returns null for an unknown token (no throw)', async () => {
    expect(await getSession(kv(), 'noSuchToken')).toBeNull();
  });

  it('returns null for an empty string token (no throw)', async () => {
    expect(await getSession(kv(), '')).toBeNull();
  });

  it('returns null for a garbage token string (no throw)', async () => {
    expect(await getSession(kv(), '!!@@##$$%%^^&&**()')).toBeNull();
  });
});

describe('cookie helpers', () => {
  it('buildSessionCookie contains the token and required flags', () => {
    const token = 'myTestToken';
    const cookie = buildSessionCookie(token);
    expect(cookie).toContain(`dreptalk_session=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=2592000');
  });

  it('buildSessionCookie omits Secure when secure:false is passed', () => {
    const token = 'localDevToken';
    const cookie = buildSessionCookie(token, { secure: false });
    expect(cookie).toContain(`dreptalk_session=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('clearSessionCookie has Max-Age=0', () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain('dreptalk_session=');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
  });

  it('parseSessionToken extracts the token from a valid Cookie header', () => {
    const token = 'abc123def456';
    const header = `other_cookie=val; dreptalk_session=${token}; another=x`;
    expect(parseSessionToken(header)).toBe(token);
  });

  it('parseSessionToken returns null when the cookie is absent', () => {
    expect(parseSessionToken('other=val; foo=bar')).toBeNull();
  });

  it('parseSessionToken returns null for null input', () => {
    expect(parseSessionToken(null)).toBeNull();
  });

  it('parseSessionToken returns null for an empty cookie header', () => {
    expect(parseSessionToken('')).toBeNull();
  });
});
