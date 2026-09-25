import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  isSeeded, resolveHandle, listDrepHandles, getPrimaryHandle, writeClaim,
  insertAutoHandles, listAutoCandidates, runHandleLifecycle,
} from './drepHandles.js';
import { upsertDrep } from './dreps.js';
import { GRACE_SEC } from '../drepLink/handle.js';
import { drepArgs, insertHandle as row, markSeeded } from '../drepLink/testHelpers.js';

const NOW = 1_800_000_000;
const A = 'drep1handleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaqqqqq';
const B = 'drep1handlebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbqqqqq';

describe('isSeeded', () => {
  it('is false until the marker row exists', async () => {
    expect(await isSeeded(env.DB)).toBe(false);
    await markSeeded(env.DB);
    expect(await isSeeded(env.DB)).toBe(true);
  });
});

describe('resolveHandle', () => {
  it('returns the drep and its slug for a live handle, null once released_at is reached', async () => {
    await upsertDrep(env.DB, drepArgs(A, 'Alice'));
    await env.DB.prepare('UPDATE dreps SET slug = ? WHERE drep_id = ?').bind('alice-qqqqq', A).run();
    await row(env.DB, 'alice', A);
    await row(env.DB, 'old-alice', A, { primary: false, releasedAt: NOW });
    expect(await resolveHandle(env.DB, 'alice', NOW)).toEqual({ drepId: A, slug: 'alice-qqqqq' });
    expect(await resolveHandle(env.DB, 'old-alice', NOW)).toBeNull();
    expect(await resolveHandle(env.DB, 'old-alice', NOW - 1)).toEqual({ drepId: A, slug: 'alice-qqqqq' });
  });
  it('returns a null slug when the DRep has none', async () => {
    await upsertDrep(env.DB, drepArgs(A, null));
    await row(env.DB, 'alice', A);
    expect(await resolveHandle(env.DB, 'alice', NOW)).toEqual({ drepId: A, slug: null });
  });
});

describe('writeClaim', () => {
  it('moves the primary to the new handle and keeps the old one in grace', async () => {
    await row(env.DB, 'alice', A);
    expect(await writeClaim(env.DB, { drepId: A, handle: 'alice-new', expectedCurrent: 'alice', now: NOW })).toEqual({ ok: true });
    const rows = await listDrepHandles(env.DB, A, NOW);
    expect(rows.map((r) => [r.handle, r.isPrimary, r.releasedAt])).toEqual([
      ['alice-new', true, null],
      ['alice', false, NOW + GRACE_SEC],
    ]);
  });
  it('refuses a handle that is live for another DRep', async () => {
    await row(env.DB, 'bob', B);
    expect(await writeClaim(env.DB, { drepId: A, handle: 'bob', expectedCurrent: null, now: NOW })).toEqual({ ok: false, error: 'taken' });
  });
  it('takes over an expired handle that cleanup has not deleted yet', async () => {
    await row(env.DB, 'bob', B, { releasedAt: NOW - 10 });
    expect(await writeClaim(env.DB, { drepId: A, handle: 'bob', expectedCurrent: null, now: NOW })).toEqual({ ok: true });
    expect(await getPrimaryHandle(env.DB, A, NOW)).toBe('bob');
  });
  it('lets a DRep take back its own previous handle', async () => {
    await row(env.DB, 'alice-new', A);
    await row(env.DB, 'alice', A, { primary: false, releasedAt: NOW + 100 });
    expect(await writeClaim(env.DB, { drepId: A, handle: 'alice', expectedCurrent: 'alice-new', now: NOW })).toEqual({ ok: true });
    const rows = await listDrepHandles(env.DB, A, NOW);
    expect(rows.map((r) => [r.handle, r.isPrimary])).toEqual([['alice', true], ['alice-new', false]]);
  });
  it('rejects a second change made from a stale form and leaves one primary', async () => {
    await row(env.DB, 'alice', A);
    expect(await writeClaim(env.DB, { drepId: A, handle: 'one', expectedCurrent: 'alice', now: NOW })).toEqual({ ok: true });
    expect(await writeClaim(env.DB, { drepId: A, handle: 'two', expectedCurrent: 'alice', now: NOW })).toEqual({ ok: false, error: 'stale' });
    expect(await getPrimaryHandle(env.DB, A, NOW)).toBe('one');
    expect(await resolveHandle(env.DB, 'two', NOW)).toBeNull();
  });
  it('lets only one of two interleaved changes through', async () => {
    // Both requests read primary 'old'. A writes first. B arrives with the same
    // server-read primary (the handler never trusts the client value).
    await row(env.DB, 'old', A);
    expect(await writeClaim(env.DB, { drepId: A, handle: 'one', expectedCurrent: 'old', now: NOW })).toEqual({ ok: true });
    expect(await writeClaim(env.DB, { drepId: A, handle: 'two', expectedCurrent: 'old', now: NOW })).toEqual({ ok: false, error: 'stale' });
    const rows = await listDrepHandles(env.DB, A, NOW);
    expect(rows.map((r) => [r.handle, r.isPrimary])).toEqual([['one', true], ['old', false]]);
  });
  it('clears the own expired primary so a re-registered DRep can claim before cleanup', async () => {
    await row(env.DB, 'mine', A, { releasedAt: NOW });
    expect(await writeClaim(env.DB, { drepId: A, handle: 'fresh', expectedCurrent: null, now: NOW })).toEqual({ ok: true });
    expect(await getPrimaryHandle(env.DB, A, NOW)).toBe('fresh');
  });
  it('treats a first claim with expectedCurrent null as stale when a primary exists', async () => {
    await row(env.DB, 'alice', A);
    expect(await writeClaim(env.DB, { drepId: A, handle: 'other', expectedCurrent: null, now: NOW })).toEqual({ ok: false, error: 'stale' });
  });
});

describe('auto assignment helpers', () => {
  it('lists registered named DReps not yet decided, and stamps decided ones', async () => {
    await upsertDrep(env.DB, drepArgs(A, 'Alice'));
    await upsertDrep(env.DB, drepArgs(B, 'Bob', 'retired'));
    await env.DB.prepare('UPDATE dreps SET registered_at = 5').run();
    expect(await listAutoCandidates(env.DB)).toEqual([{ drepId: A, name: 'Alice', registeredAt: 5, hasHandle: false }]);
    expect(await insertAutoHandles(env.DB, [{ drepId: A, handle: 'alice' }], [A], NOW)).toBe(1);
    expect(await listAutoCandidates(env.DB)).toEqual([]);
    expect(await getPrimaryHandle(env.DB, A, NOW)).toBe('alice');
  });
  it('skips DReps whose registration time is still missing', async () => {
    await upsertDrep(env.DB, drepArgs(A, 'Alice'));
    expect(await listAutoCandidates(env.DB)).toEqual([]);
  });
  it('marks candidates that already hold a handle', async () => {
    await upsertDrep(env.DB, drepArgs(A, 'Alice'));
    await env.DB.prepare('UPDATE dreps SET registered_at = 5').run();
    await row(env.DB, 'custom', A, { source: 'claim' });
    expect((await listAutoCandidates(env.DB))[0].hasHandle).toBe(true);
  });
  it('ignores a handle claimed in the meantime without failing the batch', async () => {
    await row(env.DB, 'alice', B);
    expect(await insertAutoHandles(env.DB, [{ drepId: A, handle: 'alice' }], [A], NOW)).toBe(0);
  });
});

describe('runHandleLifecycle', () => {
  it('starts grace on deregistration, restores on re-registration, deletes expired rows', async () => {
    await upsertDrep(env.DB, drepArgs(A, 'Alice', 'retired'));
    await row(env.DB, 'alice', A);
    await row(env.DB, 'alice-old', A, { primary: false, releasedAt: NOW + 50 });
    await row(env.DB, 'gone', B, { releasedAt: NOW - 1 });

    expect(await runHandleLifecycle(env.DB, NOW)).toEqual({ released: 1, restored: 0, deleted: 1 });
    const afterRelease = await listDrepHandles(env.DB, A, NOW);
    expect(afterRelease.find((r) => r.handle === 'alice')?.releasedAt).toBe(NOW + GRACE_SEC);
    expect(afterRelease.find((r) => r.handle === 'alice-old')?.releasedAt).toBe(NOW + 50);

    await env.DB.prepare(`UPDATE dreps SET status = 'registered' WHERE drep_id = ?`).bind(A).run();
    expect(await runHandleLifecycle(env.DB, NOW + 10)).toEqual({ released: 0, restored: 1, deleted: 0 });
    expect((await listDrepHandles(env.DB, A, NOW + 10))[0]).toMatchObject({ handle: 'alice', releasedAt: null });
  });
});
