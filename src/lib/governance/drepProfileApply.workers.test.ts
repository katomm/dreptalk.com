// Optimistic profile apply -- real workerd, real D1.
//
// After a DRep submits an update_drep tx, this writes the just-anchored
// document's profile straight into the dreps row so the change shows
// immediately. Authenticity is bound on-chain by the sync; this only touches
// the logged-in DRep's own row and self-heals on the next sync.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { applyDrepProfile } from './drepProfileApply.js';
import { buildDrepMetadata } from './drepMetadata.js';
import { putDrepMetadata } from '../db/drepMetadata.js';
import { upsertDrep, getDrepById } from '../db/dreps.js';

const DREP_ID = 'drep1yyqw67szjkwns4vfqvnk0v8r20zy5qmv3hge2qlxm0s3apgsp3qsk6j5t4';
const ORIGIN = 'https://dreptalk.com';
const AVATAR_SHA = 'ab'.repeat(32);

// Seed a registered dreps row with stale profile fields and chain-derived
// fields we expect the optimistic write to preserve.
async function seedRow(drepId: string) {
  await upsertDrep(env.DB, {
    drepId,
    hex: 'cd'.repeat(28),
    hasScript: false,
    status: 'registered',
    active: true,
    deposit: '500000000',
    votingPower: '12345',
    expiresEpochNo: 999,
    name: 'Old Name',
    bio: 'Old bio.',
    imageUrl: null,
    imageContentHash: null,
    imageStoredUrl: null,
    imageFetchFailedAt: null,
    links: null,
    motivations: null,
    qualifications: null,
    paymentAddress: null,
    doNotList: false,
    anchorUrl: 'https://dreptalk.com/drep/old.json',
    anchorHash: 'ff'.repeat(32),
    anchorStatus: 'ok',
    lastSyncedAt: 1_000,
    createdAt: 1_000,
  });
}

// Host a new CIP-119 document and return its { url, hash }.
async function hostDoc(drepId: string, input: { name: string; bio: string; links: { uri: string; label?: string }[]; image?: { url: string; sha256?: string }; motivations?: string; qualifications?: string; paymentAddress?: string; doNotList?: boolean }) {
  const m = buildDrepMetadata(input);
  await putDrepMetadata(env.DB, { drepId, body: m.body, hash: m.hash, name: m.name, createdAt: 1_700_000_000 });
  return { hash: m.hash };
}

describe('applyDrepProfile', () => {
  it('writes the new profile, image hash, and anchor onto the own row', async () => {
    await seedRow(DREP_ID);
    const imageUrl = `${ORIGIN}/api/avatar/${AVATAR_SHA}`;
    const { hash } = await hostDoc(DREP_ID, {
      name: 'New Name',
      bio: 'New bio.',
      links: [{ uri: 'https://example.com/a' }],
      image: { url: imageUrl, sha256: AVATAR_SHA },
    });

    const res = await applyDrepProfile({ db: env.DB, drepId: DREP_ID, hash, origin: ORIGIN, now: 2_000_000 });
    expect(res.json).toEqual({ ok: true, applied: true });

    const row = await getDrepById(env.DB, DREP_ID);
    expect(row?.name).toBe('New Name');
    expect(row?.bio).toBe('New bio.');
    expect(row?.links).toEqual([{ label: '', uri: 'https://example.com/a' }]);
    expect(row?.imageUrl).toBe(imageUrl);
    expect(row?.imageContentHash).toBe(AVATAR_SHA);
    expect(row?.imageStoredUrl).toBe(imageUrl);
    expect(row?.anchorHash).toBe(hash);
    expect(row?.anchorUrl).toBe(`${ORIGIN}/drep/${hash}.json`);
    expect(row?.anchorStatus).toBe('ok');
    // Chain-derived fields are preserved.
    expect(row?.votingPower).toBe('12345');
    expect(row?.status).toBe('registered');
  });

  it('clears the image when the new document has none', async () => {
    const id = `${DREP_ID.slice(0, -1)}x`;
    await seedRow(id);
    const { hash } = await hostDoc(id, { name: 'No Image', bio: '', links: [] });

    const res = await applyDrepProfile({ db: env.DB, drepId: id, hash, origin: ORIGIN, now: 2_000_000 });
    expect(res.json.applied).toBe(true);

    const row = await getDrepById(env.DB, id);
    expect(row?.imageUrl).toBeNull();
    expect(row?.imageContentHash).toBeNull();
  });

  it('does nothing when the caller is not a DRep', async () => {
    const res = await applyDrepProfile({ db: env.DB, drepId: null, hash: 'aa'.repeat(32), origin: ORIGIN, now: 1 });
    expect(res.json).toEqual({ ok: true, applied: false });
  });

  it('does nothing when the document hash is unknown', async () => {
    const res = await applyDrepProfile({ db: env.DB, drepId: DREP_ID, hash: '12'.repeat(32), origin: ORIGIN, now: 1 });
    expect(res.json).toEqual({ ok: true, applied: false });
  });

  it('reports applied:false when the DRep has no row yet', async () => {
    const id = 'drep1yno0r0wxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxq9norow';
    const { hash } = await hostDoc(id, { name: 'Ghost', bio: '', links: [] });
    const res = await applyDrepProfile({ db: env.DB, drepId: id, hash, origin: ORIGIN, now: 1 });
    expect(res.json.applied).toBe(false);
  });

  it('applies motivations, qualifications, payment address, and doNotList', async () => {
    const id = `${DREP_ID.slice(0, -1)}m`;
    await seedRow(id);
    const addr = `addr_test1qz${'a'.repeat(40)}`;
    const m = buildDrepMetadata({ name: 'Adv', bio: '', links: [], motivations: 'M', qualifications: 'Q', paymentAddress: addr, doNotList: true });
    await putDrepMetadata(env.DB, { drepId: id, body: m.body, hash: m.hash, name: m.name, createdAt: 1_700_000_000 });

    const res = await applyDrepProfile({ db: env.DB, drepId: id, hash: m.hash, origin: ORIGIN, now: 2_000_000 });
    expect(res.json.applied).toBe(true);

    const row = await getDrepById(env.DB, id);
    expect(row?.motivations).toBe('M');
    expect(row?.qualifications).toBe('Q');
    expect(row?.paymentAddress).toBe(addr);
    expect(row?.doNotList).toBe(true);
  });
});
