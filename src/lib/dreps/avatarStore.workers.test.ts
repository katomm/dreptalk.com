// Avatar store tests; run in workerd with the real miniflare R2 binding
// (AVATARS) and D1. The image fetch is injected.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { storeDrepAvatars, gcDrepAvatars, AVATAR_KEY_PREFIX } from './avatarStore.js';
import { upsertDrep, getDrepById, listDrepsNeedingAvatar, countGivenUpAvatars } from '../db/dreps.js';
import { bytesToHex } from '../crypto/hex.js';

const db = () => env.DB;
const bucket = () => env.AVATARS as R2Bucket;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

async function sha256Of(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function imageResponse(bytes: Uint8Array, contentType = 'image/png'): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

const BASE = {
  hex: 'ab01',
  hasScript: false,
  status: 'registered',
  active: true,
  deposit: null,
  votingPower: null,
  expiresEpochNo: null,
  name: null,
  bio: null,
  links: null,
  anchorUrl: null,
  anchorHash: null,
  anchorStatus: 'no-anchor',
  lastSyncedAt: 1,
  createdAt: 1,
  imageContentHash: null,
  imageStoredUrl: null,
  imageFetchFailedAt: null,
};

describe('storeDrepAvatars', () => {
  it('downloads, stores at avatars/<sha256>, and stamps the row', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-ok', imageUrl: 'https://img.example/ok.png' });
    const fetchImpl = (async () => imageResponse(PNG_BYTES)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.stored).toBe(1);

    const hash = await sha256Of(PNG_BYTES);
    const obj = await bucket().get(AVATAR_KEY_PREFIX + hash);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata?.contentType).toBe('image/png');

    const row = await getDrepById(db(), 'st-ok');
    expect(row!.imageContentHash).toBe(hash);
    expect(row!.imageStoredUrl).toBe('https://img.example/ok.png');
  });

  it('skips rows already stored with an unchanged source', async () => {
    await upsertDrep(db(), {
      ...BASE,
      drepId: 'st-skip',
      imageUrl: 'https://img.example/same.png',
      imageContentHash: 'a'.repeat(64),
      imageStoredUrl: 'https://img.example/same.png',
    });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return imageResponse(PNG_BYTES);
    }) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(calls).toBe(0);
    expect(r.scanned).toBe(0);
  });

  it('rejects a non-https source without fetching', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-http', imageUrl: 'http://img.example/insecure.png' });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return imageResponse(PNG_BYTES);
    }) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(calls).toBe(0);
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-http'))!.imageContentHash).toBeNull();
  });

  it('rejects a disallowed content type and leaves the row unchanged', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-svg', imageUrl: 'https://img.example/evil.svg' });
    const fetchImpl = (async () => imageResponse(PNG_BYTES, 'image/svg+xml')) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-svg'))!.imageContentHash).toBeNull();
  });

  it('rejects an oversize body', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-big', imageUrl: 'https://img.example/big.png' });
    const big = new Uint8Array(256 * 1024 + 1);
    const fetchImpl = (async () => imageResponse(big)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-big'))!.imageContentHash).toBeNull();
  });

  it('rejects an oversize content-length declaration before reading the body', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-declared', imageUrl: 'https://img.example/declared.png' });
    // Small body, but the declared length exceeds the cap: the early reject fires.
    const fetchImpl = (async () =>
      new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(256 * 1024 + 1) },
      })) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-declared'))!.imageContentHash).toBeNull();
  });

  it('a fetch failure leaves the stored columns unchanged for the next run', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-err', imageUrl: 'https://img.example/down.png' });
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-err'))!.imageStoredUrl).toBeNull();
  });

  it('a failed download stamps the row with the run time', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-stamp', imageUrl: 'https://img.example/dead.png' });
    const fetchImpl = (async () => {
      throw new Error('host down');
    }) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, nowMs: 42_000 });
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-stamp'))!.imageFetchFailedAt).toBe(42_000);
  });

  it('a permanently failing source rotates back and cannot starve a fresh row', async () => {
    // 'a-bad' sorts before 'z-new' by drep_id; with limit 1 and no rotation it
    // would monopolize every run and 'z-new' would never be attempted.
    await upsertDrep(db(), { ...BASE, drepId: 'a-bad', imageUrl: 'https://img.example/dead.png' });
    await upsertDrep(db(), { ...BASE, drepId: 'z-new', imageUrl: 'https://img.example/ok.png' });
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith('dead.png')) throw new Error('host down');
      return imageResponse(PNG_BYTES);
    }) as unknown as typeof fetch;

    const r1 = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, limit: 1, nowMs: 1_000 });
    expect(r1.failed).toBe(1);

    // Second run: the failure is stamped, so the never-attempted row goes first.
    const r2 = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, limit: 1, nowMs: 2_000 });
    expect(r2.stored).toBe(1);
    expect((await getDrepById(db(), 'z-new'))!.imageStoredUrl).toBe('https://img.example/ok.png');

    // Third run: only the broken row is left; it is retried, not blacklisted.
    const r3 = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, limit: 1, nowMs: 3_000 });
    expect(r3.failed).toBe(1);
    expect((await getDrepById(db(), 'a-bad'))!.imageFetchFailedAt).toBe(3_000);
  });

  it('clears the stored columns when the source image disappeared', async () => {
    await upsertDrep(db(), {
      ...BASE,
      drepId: 'st-gone',
      imageUrl: null,
      imageContentHash: 'b'.repeat(64),
      imageStoredUrl: 'https://img.example/was.png',
    });
    const fetchImpl = (async () => imageResponse(PNG_BYTES)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.cleared).toBe(1);
    expect((await getDrepById(db(), 'st-gone'))!.imageContentHash).toBeNull();
  });
});

describe('gcDrepAvatars', () => {
  it('deletes orphaned objects past the grace period, keeps referenced ones', async () => {
    const keepHash = '3'.repeat(64);
    await upsertDrep(db(), { ...BASE, drepId: 'gc-ref', imageUrl: 'https://img.example/r.png', imageContentHash: keepHash, imageStoredUrl: 'https://img.example/r.png' });
    await bucket().put(AVATAR_KEY_PREFIX + keepHash, PNG_BYTES);
    await bucket().put(AVATAR_KEY_PREFIX + '4'.repeat(64), PNG_BYTES);

    // Both objects were uploaded "now"; evaluating 25h in the future puts the
    // orphan past the 24h grace period.
    const r = await gcDrepAvatars({ db: db(), bucket: bucket(), nowMs: Date.now() + 25 * 60 * 60 * 1000 });
    expect(r.deleted).toBe(1);
    expect(await bucket().get(AVATAR_KEY_PREFIX + keepHash)).not.toBeNull();
    expect(await bucket().get(AVATAR_KEY_PREFIX + '4'.repeat(64))).toBeNull();
  });

  it('keeps a fresh orphan inside the grace period', async () => {
    await bucket().put(AVATAR_KEY_PREFIX + '5'.repeat(64), PNG_BYTES);

    const r = await gcDrepAvatars({ db: db(), bucket: bucket(), nowMs: Date.now() });
    expect(r.deleted).toBe(0);
    expect(await bucket().get(AVATAR_KEY_PREFIX + '5'.repeat(64))).not.toBeNull();
  });
});

describe('avatar give-up', () => {
  const fail404 = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;

  it('gives up on a DRep after maxAttempts failed fetches and surfaces the count', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'gu-dead', imageUrl: 'https://dead.example/x.png' });

    // Two runs, cap 2: each fails and increments the attempt counter. A high limit
    // ensures gu-dead is reached every run despite other rows in the shared DB.
    expect((await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl: fail404, maxAttempts: 2, limit: 500 })).failed)
      .toBeGreaterThanOrEqual(1);
    await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl: fail404, maxAttempts: 2, limit: 500 });

    // At the cap: excluded from the candidate query, counted as given up.
    const candidates = await listDrepsNeedingAvatar(db(), 500, 2);
    expect(candidates.find((c) => c.drepId === 'gu-dead')).toBeUndefined();
    expect(await countGivenUpAvatars(db(), 2)).toBeGreaterThanOrEqual(1);
  });

  it('resets the attempt counter on a successful store', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'gu-recover', imageUrl: 'https://flaky.example/x.png' });
    const ok = (async () => imageResponse(PNG_BYTES)) as unknown as typeof fetch;

    await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl: fail404, maxAttempts: 5, limit: 500 });
    await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl: ok, maxAttempts: 5, limit: 500 });

    const row = await db()
      .prepare("SELECT image_fetch_attempts AS a FROM dreps WHERE drep_id = 'gu-recover'")
      .first<{ a: number }>();
    expect(row?.a).toBe(0);
  });
});
