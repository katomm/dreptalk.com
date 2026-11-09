/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { profilesToFetch, upsertProfile, websitesToCheck, type ProfileRow } from '../db/drepGroups.js';
import { type GroupSeed, seedGroup as seedGroupRow } from './__tests__/engineFixtures.js';
import { txHex as txOf } from './__tests__/loadFixtures.js';
import { hashBytes } from './codec.js';
import { groupIdString } from './ids.js';
import { PROFILE_RETRY_MS, WEBSITE_RECHECK_MS } from './constants.js';
import { extractGroupProfile, refreshGroupProfiles, verifyGroupWebsites } from './profile.js';
import { buildProfileDoc, putProfileDoc } from './profileDocs.js';
import { anchorDueBatch } from './store/commit.js';
import { acquireLease, invocationOwner, writeBatch } from './store/lease.js';

const db = env.DB as D1Database;
const docBytes = new TextEncoder().encode(
  JSON.stringify({
    '@context': {},
    hashAlgorithm: 'blake2b-256',
    body: { name: 'Council', website: 'https://council.test', paymentAddresses: [{ address: 'addr_test1x', purpose: 'donations' }] },
  }),
);
const docHash = bytesToHex(blake2b256(docBytes));
const okFetch = () => vi.fn().mockResolvedValue(new Response(docBytes, { status: 200, headers: { 'content-type': 'application/json' } }));
const URL_A = 'https://host.test/g.json';
const idOf = (n: number): string => groupIdString({ txHash: txOf(n), index: 0 });
const lease = async (): Promise<string> => (await acquireLease(db, invocationOwner())) as string;

/** A group row with the anchor of the test document unless the seed names another. */
const seedGroup = (n: number, o: GroupSeed = {}): Promise<void> => seedGroupRow(db, n, { url: URL_A, hash: docHash, ...o });

const dueRows = async (): Promise<Array<{ kind: string; due_at: number }>> =>
  ((await db.prepare('SELECT kind, due_at FROM drep_group_due ORDER BY kind, due_at').all<{ kind: string; due_at: number }>()).results ?? []);

const site = (n: number, website: string): ProfileRow => ({
  groupId: idOf(n),
  profileUrl: URL_A,
  dataHash: docHash,
  status: 'ok',
  name: 'Council',
  description: null,
  website,
  image: null,
  charter: null,
  paymentAddresses: [],
  fetchedAt: 1,
  websiteVerifiedAt: null,
  websiteCheckedAt: null,
});

const profileOf = async (n: number) =>
  db.prepare('SELECT * FROM drep_group_profiles WHERE group_tx = ?').bind(hashBytes(txOf(n))).first<Record<string, unknown>>();

describe('group profiles', () => {
  it('extracts body fields and caps them', () => {
    const p = extractGroupProfile({
      body: { name: { '@value': ' Council ' }, description: 'x'.repeat(5000), paymentAddresses: [{ address: 'a' }, { nope: 1 }] },
    });
    expect(p.name).toBe('Council');
    expect(p.description?.length).toBe(2000);
    expect(p.paymentAddresses).toEqual([{ address: 'a' }]);
    const many = extractGroupProfile({ body: { paymentAddresses: Array.from({ length: 30 }, (_, i) => ({ address: `a${i}` })) } });
    expect(many.paymentAddresses).toHaveLength(10);
  });

  it('keeps the paragraphs of the description', () => {
    const p = extractGroupProfile({ body: { name: 'C\nx', description: 'First.\r\n\r\n\n\nSecond line\nthird.\u0007' } });
    expect(p.description).toBe('First.\n\nSecond line\nthird.');
    expect(p.name).toBe('Cx');
  });

  it('drops non http urls', () => {
    const p = extractGroupProfile({ body: { website: 'javascript:alert(1)', charter: 'data:text/html,x', image: 'https://img.test/a.png' } });
    expect(p).toMatchObject({ website: null, charter: null, image: 'https://img.test/a.png' });
  });

  it('stores a verified profile and moves the due rows', async () => {
    await seedGroup(1, { due: 'profile' });
    const l = await lease();
    expect(await refreshGroupProfiles({ db, lease: l, fetchImpl: okFetch(), now: 5, limit: 10 })).toEqual({ fetched: 1, failed: 0 });
    expect(await profileOf(1)).toMatchObject({ status: 'ok', name: 'Council', website: 'https://council.test' });
    expect(await dueRows()).toEqual([{ kind: 'website', due_at: 5 }]);
  });

  it('reads a profile hosted on our own zone from the document store', async () => {
    const doc = buildProfileDoc({ name: 'Hosted council', website: 'https://hosted.test' });
    await putProfileDoc(db, { hash: doc.hash, body: doc.body, createdBy: 'u1', now: 1 });
    await seedGroup(1, { url: `https://preprod.dreptalk.com/group-profile/${doc.hash}.json`, hash: doc.hash, due: 'profile' });
    const fetchImpl = vi.fn();
    const l = await lease();
    expect(await refreshGroupProfiles({ db, lease: l, fetchImpl, now: 5, limit: 10 })).toEqual({ fetched: 1, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await profileOf(1)).toMatchObject({ status: 'ok', name: 'Hosted council', website: 'https://hosted.test' });
  });

  it('marks a hash mismatch and keeps fields empty', async () => {
    await seedGroup(1, { hash: '0'.repeat(64), due: 'profile' });
    const l = await lease();
    await refreshGroupProfiles({ db, lease: l, fetchImpl: okFetch(), now: 5, limit: 10 });
    expect(await profileOf(1)).toMatchObject({ status: 'hash-mismatch', name: null, website: null });
    expect(await dueRows()).toEqual([{ kind: 'profile', due_at: 5 + PROFILE_RETRY_MS }]);
  });

  it('retries an unreachable profile after the retry delay', async () => {
    await seedGroup(1, { due: 'profile' });
    const l = await lease();
    const down = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    expect(await refreshGroupProfiles({ db, lease: l, fetchImpl: down, now: 5, limit: 10 })).toEqual({ fetched: 0, failed: 1 });
    expect(await refreshGroupProfiles({ db, lease: l, fetchImpl: okFetch(), now: 10, limit: 10 })).toEqual({ fetched: 0, failed: 0 });
    expect(await refreshGroupProfiles({ db, lease: l, fetchImpl: okFetch(), now: 5 + PROFILE_RETRY_MS, limit: 10 })).toEqual({ fetched: 1, failed: 0 });
  });

  it('verifies a website only for the right network', async () => {
    await seedGroup(1, { due: 'website' });
    const l = await lease();
    await upsertProfile(db, l, site(1, 'https://council.test/about'), 1);
    const ok = vi.fn().mockResolvedValue(new Response(JSON.stringify({ preprod: [idOf(1)] }), { status: 200 }));
    expect(await verifyGroupWebsites({ db, lease: l, fetchImpl: ok, now: 10, network: 'preprod', limit: 10 })).toEqual({ checked: 1, verified: 1 });
    expect(String(ok.mock.calls[0]?.[0])).toBe('https://council.test/.well-known/cardano-drep-groups.json');
    expect(await profileOf(1)).toMatchObject({ website_verified_at: 10, website_checked_at: 10 });
    expect(await dueRows()).toEqual([{ kind: 'website', due_at: 10 + WEBSITE_RECHECK_MS }]);
    await upsertProfile(db, l, site(1, 'https://council.test'), 20);
    const wrongNet = vi.fn().mockResolvedValue(new Response(JSON.stringify({ mainnet: [idOf(1)] }), { status: 200 }));
    expect(await verifyGroupWebsites({ db, lease: l, fetchImpl: wrongNet, now: 20, network: 'preprod', limit: 10 })).toEqual({ checked: 1, verified: 0 });
    expect(await profileOf(1)).toMatchObject({ website_verified_at: null, website_checked_at: 20 });
  });

  it('treats a redirect, an oversized body and a hanging host as unverified', async () => {
    await seedGroup(1);
    const l = await lease();
    const cases: Array<typeof fetch> = [
      vi.fn().mockResolvedValue(new Response(null, { status: 301, headers: { location: 'https://elsewhere.test/' } })),
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ preprod: [idOf(1)], pad: 'x'.repeat(70_000) }), { status: 200 })),
      vi.fn(
        (_u: string, init?: RequestInit) =>
          new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      ) as unknown as typeof fetch,
    ];
    let now = 30;
    for (const fetchImpl of cases) {
      await upsertProfile(db, l, site(1, 'https://council.test'), now);
      expect(await verifyGroupWebsites({ db, lease: l, fetchImpl, now, network: 'preprod', limit: 10, timeoutMs: 50 })).toEqual({ checked: 1, verified: 0 });
      now += 1;
    }
  });

  it('skips groups without members and picks a group once it gets its first member', async () => {
    // Group 1 has no member, group 2 has no anchor, group 3 is due, group 4 is due behind the page.
    await seedGroup(1, { members: 0, due: 'profile' });
    await seedGroup(2, { url: null, hash: null, due: 'profile', dueAt: 1 });
    await seedGroup(3, { due: 'profile', dueAt: 2 });
    const plain = new TextEncoder().encode(JSON.stringify({ body: { name: 'No site' } }));
    await seedGroup(4, { hash: bytesToHex(blake2b256(plain)), due: 'profile', dueAt: 3 });
    const l = await lease();
    expect(await profilesToFetch(db, 100, 3, l)).toEqual([{ groupId: idOf(3), url: URL_A, dataHash: docHash }]);
    // The two stale rows of the page are gone, the other two stay.
    expect(await dueRows()).toHaveLength(2);
    // Group 5 gets its first member, a due row is written like commit does it.
    await seedGroup(5, { members: 0 });
    await db.prepare('UPDATE drep_groups SET members = 1 WHERE group_tx = ?').bind(hashBytes(txOf(5))).run();
    await db.prepare('DELETE FROM drep_group_due WHERE group_tx = ?').bind(hashBytes(txOf(3))).run();
    // A successful profile without a website writes no website due row.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(plain, { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await refreshGroupProfiles({ db, lease: l, fetchImpl, now: 100, limit: 10 })).toEqual({ fetched: 1, failed: 0 });
    expect(await dueRows()).toEqual([]);
    expect(await websitesToCheck(db, 1e9, 10, l)).toEqual([]);
  });

  it('an anchor change of a listed group makes its profile due at once', async () => {
    await seedGroup(1, { due: 'profile' });
    const l = await lease();
    await refreshGroupProfiles({ db, lease: l, fetchImpl: okFetch(), now: 5, limit: 10 });
    expect(await profilesToFetch(db, 1e9, 10, l)).toEqual([]);
    const next = '1'.repeat(64);
    await db.prepare('UPDATE drep_groups SET profile_url = ?, profile_hash = ? WHERE group_tx = ?').bind('https://host.test/h.json', hashBytes(next), hashBytes(txOf(1))).run();
    await writeBatch(db, l, anchorDueBatch(db, [{ group: { txHash: txOf(1), index: 0 }, before: { url: URL_A, hash: docHash }, after: { url: 'https://host.test/h.json', hash: next } }], 50));
    expect(await profilesToFetch(db, 50, 10, l)).toEqual([{ groupId: idOf(1), url: 'https://host.test/h.json', dataHash: next }]);
    // The website due row of the old profile is gone with the change.
    expect((await dueRows()).map((r) => r.kind)).toEqual(['profile']);
  });

  it('drops control characters, caps by code points and accepts only a hex treasury script', () => {
    const p = extractGroupProfile({
      body: {
        name: `Co\u0000un\u0007cil`,
        description: '\u{1F600}'.repeat(2001),
        paymentAddresses: [
          { address: 'a', treasuryScript: 'a'.repeat(56) },
          { address: 'b', treasuryScript: 'A'.repeat(56) },
          { address: 'c', treasuryScript: 'zz' },
        ],
      },
    });
    expect(p.name).toBe('Council');
    expect(Array.from(p.description ?? '')).toHaveLength(2000);
    expect(p.description?.endsWith('\u{1F600}')).toBe(true);
    expect(p.paymentAddresses).toEqual([{ address: 'a', treasuryScript: 'a'.repeat(56) }, { address: 'b' }, { address: 'c' }]);
  });

  it('keeps a stored profile on a transient failure and only delays it', async () => {
    await seedGroup(1, { due: 'profile' });
    const l = await lease();
    await refreshGroupProfiles({ db, lease: l, fetchImpl: okFetch(), now: 5, limit: 10 });
    await db.prepare("UPDATE drep_group_due SET due_at = 0 WHERE kind = 'website'").run();
    await db.prepare('UPDATE drep_group_profiles SET website_verified_at = 7, website_checked_at = 7').run();
    await db.prepare("INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at) VALUES ('profile', ?, 0, 0)").bind(hashBytes(txOf(1))).run();
    for (const failing of [
      vi.fn().mockResolvedValue(new Response('', { status: 503 })),
      vi.fn().mockRejectedValue(new Error('network')),
    ]) {
      await db.prepare("UPDATE drep_group_due SET due_at = 0 WHERE kind = 'profile'").run();
      expect(await refreshGroupProfiles({ db, lease: l, fetchImpl: failing as unknown as typeof fetch, now: 100, limit: 10 })).toEqual({ fetched: 0, failed: 1 });
      expect(await profileOf(1)).toMatchObject({ status: 'ok', name: 'Council', website: 'https://council.test', website_verified_at: 7 });
      expect((await dueRows()).filter((r) => r.kind === 'profile')).toEqual([{ kind: 'profile', due_at: 100 + PROFILE_RETRY_MS }]);
    }
  });

  it('empties the fields for a document that is not a valid profile', async () => {
    const junk = new TextEncoder().encode('not json');
    await seedGroup(1, { hash: bytesToHex(blake2b256(junk)), due: 'profile' });
    const l = await lease();
    await upsertProfile(db, l, { ...site(1, 'https://council.test'), dataHash: bytesToHex(blake2b256(junk)) }, 1);
    await db.prepare("INSERT INTO drep_group_due (kind, group_tx, group_ix, due_at) VALUES ('profile', ?, 0, 0)").bind(hashBytes(txOf(1))).run();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(junk, { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await refreshGroupProfiles({ db, lease: l, fetchImpl, now: 5, limit: 10 })).toEqual({ fetched: 0, failed: 1 });
    expect(await profileOf(1)).toMatchObject({ status: 'parse-failed', name: null, website: null });
  });
});
