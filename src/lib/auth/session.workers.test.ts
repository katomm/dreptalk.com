// Opaque KV session tests -- runs in real workerd via @cloudflare/vitest-plugin.
// env.SESSIONS is the real KV binding provided by miniflare.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createSession,
  getSession,
  revokeSession,
  revokeAllForUser,
  sessionUserFromRecord,
  resolveSessionLocals,
  listSessionsForUser,
  revokeSessionForUser,
  sessionIdForToken,
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

describe('createSession carries drepId', () => {
  it('round-trips a drepId set at mint time', async () => {
    const now = 1_700_000_000;
    const drepId = 'drep1selftest';
    const token = await createSession(
      kv(),
      { id: 'user-drep', roles: ['drep'], drepId },
      { now },
    );
    const record = await getSession(kv(), token, { now });
    expect(record!.drepId).toBe(drepId);
  });

  it('stores drepId as null when the user has none', async () => {
    const token = await createSession(kv(), { id: 'user-no-drep', roles: ['member'] });
    const record = await getSession(kv(), token);
    expect(record!.drepId).toBeNull();
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

describe('sessionUserFromRecord', () => {
  const base = { userId: 'u1', roles: ['drep'], drepId: 'drep1', createdAt: 1, lastSeen: 1 };

  it('maps a record with null grantId and actsFor to a plain user', () => {
    const user = sessionUserFromRecord({ ...base, grantId: null, actsFor: null });
    expect(user).toMatchObject({ id: 'u1', roles: ['drep'], drepId: 'drep1' });
    expect(user).not.toHaveProperty('grantId');
    expect(user).not.toHaveProperty('actsFor');
  });

  it('maps a legacy record without the fields', () => {
    expect(sessionUserFromRecord(base)).not.toBeNull();
  });

  it('rejects a record still pinned to a grant or acting for a principal', () => {
    expect(sessionUserFromRecord({ ...base, grantId: 'g1' })).toBeNull();
    expect(sessionUserFromRecord({ ...base, actsFor: { userId: 'p', stakeAddr: 's' } })).toBeNull();
  });
});

describe('resolveSessionLocals (middleware session step)', () => {
  async function putRecord(extra: Record<string, unknown>): Promise<string> {
    const token = await createSession(kv(), { id: 'mw-user', roles: ['drep'], drepId: 'd1' });
    const hash = await sessionIdForToken(token);
    const key = `sess:${hash}`;
    const rec = JSON.parse((await kv().get(key))!);
    await kv().put(key, JSON.stringify({ ...rec, ...extra }));
    return token;
  }

  it('gives no user and a clearing cookie for a record pinned to a grant', async () => {
    const token = await putRecord({ grantId: 'g1', actsFor: { userId: 'p', stakeAddr: 's' } });
    expect(await resolveSessionLocals(kv(), token)).toEqual({ user: null, cookieAction: 'clear' });
  });

  it('gives a normal user and no cookie change for null grantId and actsFor', async () => {
    const token = await putRecord({ grantId: null, actsFor: null });
    const r = await resolveSessionLocals(kv(), token);
    expect(r.cookieAction).toBe('none');
    expect(r.user).toMatchObject({ id: 'mw-user', roles: ['drep'] });
    expect(r.user).not.toHaveProperty('grantId');
  });

  it('clears the cookie for an unknown token', async () => {
    expect(await resolveSessionLocals(kv(), 'nope')).toEqual({ user: null, cookieAction: 'clear' });
  });
});

describe('minted sessions carry no grant fields', () => {
  it('createSession stores no grantId or gsess index', async () => {
    const token = await createSession(kv(), { id: 'no-grant-user', roles: ['proposer'] });
    const record = (await getSession(kv(), token)) as unknown as Record<string, unknown>;
    expect(record).not.toHaveProperty('grantId');
    expect(record).not.toHaveProperty('actsFor');
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

describe('absolute session lifetime', () => {
  const DAY = 86_400;

  it('keeps a session that is old but still under the cap', async () => {
    const now = 1_700_000_000;
    const token = await createSession(kv(), { id: 'user-cap-1', roles: [] }, { now });
    const record = await getSession(kv(), token, { now: now + 89 * DAY });
    expect(record).not.toBeNull();
  });

  it('rejects and deletes a session past the cap, however recently it was used', async () => {
    const now = 1_700_000_000;
    const token = await createSession(kv(), { id: 'user-cap-2', roles: [] }, { now });
    // Keep it warm right up to the cap: the sliding renewal must not save it.
    await getSession(kv(), token, { now: now + 89 * DAY });

    expect(await getSession(kv(), token, { now: now + 91 * DAY })).toBeNull();
    // Second call proves the record was deleted, not merely hidden.
    expect(await getSession(kv(), token, { now: now + 91 * DAY })).toBeNull();
    expect(await listSessionsForUser(kv(), 'user-cap-2', { now: now + 91 * DAY })).toEqual([]);
  });

  it('counts an inherited lifetime start, not its own creation, toward the cap', async () => {
    const start = 1_700_000_000;
    const now = start + 80 * DAY;
    const token = await createSession(kv(), { id: 'user-cap-3', roles: [] }, { now, lifetimeStart: start });
    const record = await getSession(kv(), token, { now });
    // createdAt stays the real sign-in time on this device, for the device list.
    expect(record!.createdAt).toBe(now);
    expect(await getSession(kv(), token, { now: start + 91 * DAY })).toBeNull();
  });

  it('never lets an inherited lifetime start lie in the future', async () => {
    const now = 1_700_000_000;
    const token = await createSession(kv(), { id: 'user-cap-4', roles: [] }, { now, lifetimeStart: now + 30 * DAY });
    expect(await getSession(kv(), token, { now: now + 91 * DAY })).toBeNull();
  });
});

describe('onSlide callback', () => {
  it('fires only when the sliding renewal writes, so the cookie is re-issued with it', async () => {
    const now = 1_700_000_000;
    const token = await createSession(kv(), { id: 'user-slide', roles: [] }, { now });

    let slides = 0;
    await getSession(kv(), token, { now: now + 60, onSlide: () => { slides += 1; } });
    expect(slides).toBe(0);

    await getSession(kv(), token, { now: now + 7 * 3600, onSlide: () => { slides += 1; } });
    expect(slides).toBe(1);
  });
});

describe('listSessionsForUser', () => {
  it('lists every live session for the user, newest activity first', async () => {
    const now = 1_700_000_000;
    const first = await createSession(kv(), { id: 'user-list', roles: [] }, { now, label: 'Mac, Chrome' });
    await createSession(kv(), { id: 'user-list', roles: [] }, { now: now + 10, label: 'iPhone, Safari' });
    // Touch the older session so it becomes the most recently used one.
    await getSession(kv(), first, { now: now + 7 * 3600 });

    const sessions = await listSessionsForUser(kv(), 'user-list', { now: now + 7 * 3600 });
    expect(sessions.map((s) => s.label)).toEqual(['Mac, Chrome', 'iPhone, Safari']);
    expect(sessions[0].createdAt).toBe(now);
    expect(sessions[0].lastSeen).toBe(now + 7 * 3600);
  });

  it('reports a null label for a session minted without a User-Agent', async () => {
    const now = 1_700_000_000;
    await createSession(kv(), { id: 'user-nolabel', roles: [] }, { now });
    const sessions = await listSessionsForUser(kv(), 'user-nolabel', { now });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].label).toBeNull();
  });

  it('returns an empty list for a user with no sessions', async () => {
    expect(await listSessionsForUser(kv(), 'user-none')).toEqual([]);
  });

  it('drops a stale index entry whose record is gone', async () => {
    const now = 1_700_000_000;
    const token = await createSession(kv(), { id: 'user-stale', roles: [] }, { now });
    // Delete the record directly, leaving the index entry behind.
    await kv().delete(`sess:${await sessionIdForToken(token)}`);

    expect(await listSessionsForUser(kv(), 'user-stale', { now })).toEqual([]);
    expect(await kv().get('usess:user-stale')).toBeNull();
  });
});

describe('revokeSessionForUser', () => {
  it('revokes the caller own session and leaves their other devices signed in', async () => {
    const now = 1_700_000_000;
    const keep = await createSession(kv(), { id: 'user-rev', roles: [] }, { now });
    const drop = await createSession(kv(), { id: 'user-rev', roles: [] }, { now });
    const dropId = await sessionIdForToken(drop);

    expect(await revokeSessionForUser(kv(), 'user-rev', dropId)).toBe(true);
    expect(await getSession(kv(), drop, { now })).toBeNull();
    expect(await getSession(kv(), keep, { now })).not.toBeNull();
    expect(await listSessionsForUser(kv(), 'user-rev', { now })).toHaveLength(1);
  });

  it('refuses a session id belonging to another user', async () => {
    const now = 1_700_000_000;
    const victim = await createSession(kv(), { id: 'user-victim', roles: [] }, { now });
    const victimId = await sessionIdForToken(victim);

    expect(await revokeSessionForUser(kv(), 'user-attacker', victimId)).toBe(false);
    expect(await getSession(kv(), victim, { now })).not.toBeNull();
  });

  it('refuses an unknown or malformed id without touching KV', async () => {
    expect(await revokeSessionForUser(kv(), 'user-x', 'not-a-hash')).toBe(false);
    expect(await revokeSessionForUser(kv(), 'user-x', 'a'.repeat(64))).toBe(false);
  });
});
