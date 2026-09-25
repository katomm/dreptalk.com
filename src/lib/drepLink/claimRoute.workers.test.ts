import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { claimHandleRequest } from './claimRequest.js';
import { upsertDrep } from '../db/dreps.js';
import { getPrimaryHandle } from '../db/drepHandles.js';
import { drepArgs, insertHandle, markSeeded } from './__fixtures__/drepHandles.js';
import { COOLDOWN_SEC, GRACE_SEC } from './handle.js';

const NOW = 1_800_000_000;
const A = 'drep1claimaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaqqqqq';
const drepUser = { id: 'u1', roles: ['drep'], drepId: A, grantId: null };
const call = (user: App.Locals['user'], body: unknown) => claimHandleRequest({ db: env.DB, user, body, now: NOW });

describe('claimHandleRequest', () => {
  it('rejects anonymous, grant sessions and non-DReps', async () => {
    expect((await call(null, {})).status).toBe(401);
    expect((await call({ ...drepUser, grantId: 'g' }, {})).status).toBe(403);
    expect((await call({ id: 'u2', roles: [], drepId: null }, {})).status).toBe(403);
  });
  it('is closed until the seed exists', async () => {
    await upsertDrep(env.DB, drepArgs(A, 'Alice'));
    expect(await call(drepUser, { handle: 'alice', expectedCurrent: null })).toMatchObject({ status: 503, body: { error: 'not_open' } });
  });
  it('answers not_synced for a DRep the sync has not stored yet', async () => {
    await markSeeded(env.DB);
    expect(await call(drepUser, { handle: 'alice', expectedCurrent: null })).toMatchObject({ status: 409, body: { error: 'not_synced' } });
  });
  it('refuses a deregistered DRep with a still valid session', async () => {
    await markSeeded(env.DB);
    await upsertDrep(env.DB, drepArgs(A, 'Alice', 'deregistered'));
    expect(await call(drepUser, { handle: 'alice', expectedCurrent: null })).toMatchObject({ status: 403, body: { error: 'not_registered' } });
  });
  it('claims, normalizes input, and then enforces the cooldown', async () => {
    await markSeeded(env.DB);
    await upsertDrep(env.DB, drepArgs(A, 'Alice'));
    expect(await call(drepUser, { handle: ' drep.link/Alice-Two ', expectedCurrent: null })).toEqual({
      status: 200,
      body: { ok: true, handle: 'alice-two', previous: null, cooldownUntil: NOW + COOLDOWN_SEC },
    });
    expect(await getPrimaryHandle(env.DB, A, NOW)).toBe('alice-two');
    expect(await call(drepUser, { handle: 'alice-three', expectedCurrent: 'alice-two' })).toMatchObject({ status: 409, body: { error: 'cooldown' } });
  });
  it('refuses a forged expectedCurrent that does not match the stored primary', async () => {
    await markSeeded(env.DB);
    await upsertDrep(env.DB, drepArgs(A, 'Alice'));
    await insertHandle(env.DB, 'old', A);
    expect(await call(drepUser, { handle: 'two', expectedCurrent: 'one' })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect(await getPrimaryHandle(env.DB, A, NOW)).toBe('old');
    expect(await call(drepUser, { handle: 'two', expectedCurrent: 'old' })).toMatchObject({
      status: 200,
      body: { previous: { handle: 'old', until: NOW + GRACE_SEC } },
    });
  });
  it('reports a handle live for someone else as taken', async () => {
    await markSeeded(env.DB);
    await upsertDrep(env.DB, drepArgs(A, 'Alice'));
    await insertHandle(env.DB, 'bob', 'drep1someoneelse');
    expect(await call(drepUser, { handle: 'bob', expectedCurrent: null })).toMatchObject({ status: 409, body: { error: 'taken' } });
  });
  it('rejects a malformed body', async () => {
    await markSeeded(env.DB);
    await upsertDrep(env.DB, drepArgs(A, 'Alice'));
    expect((await call(drepUser, { handle: 5 })).status).toBe(400);
    expect((await call(drepUser, null)).status).toBe(400);
  });
});
