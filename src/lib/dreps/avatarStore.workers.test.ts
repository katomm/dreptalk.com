// Avatar store tests; run in workerd with the real miniflare R2 binding
// (AVATARS) and D1. The image fetch is injected.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  storeDrepAvatars,
  gcDrepAvatars,
  decodeDataUriImage,
  ingestDataUriAvatar,
  AVATAR_KEY_PREFIX,
  type ImageDownscaler,
} from './avatarStore.js';
import { upsertDrep, getDrepById, listDrepsNeedingAvatar, countGivenUpAvatars } from '../db/dreps.js';
import { bytesToHex } from '../crypto/hex.js';
import { toArrayBuffer } from '../crypto/bytes.js';

const db = () => env.DB;
const bucket = () => env.AVATARS as R2Bucket;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
// Stand-in for downscaler output; the real bytes come from the Images binding.
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9, 9]);

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
  motivations: null,
  qualifications: null,
  paymentAddress: null,
  doNotList: false,
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

  it('stores a body up to the cap as-is without downscaling', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-midsize', imageUrl: 'https://img.example/mid.png' });
    // 300 KB: over the old 256 KB cap, under the new 512 KB cap -> stored as-is.
    const mid = new Uint8Array(300 * 1024);
    mid.set(PNG_BYTES);
    let downscaleCalls = 0;
    const downscale: ImageDownscaler = async () => {
      downscaleCalls++;
      return null;
    };
    const fetchImpl = (async () => imageResponse(mid)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, downscale });
    expect(r.stored).toBe(1);
    expect(downscaleCalls).toBe(0);
    expect((await getDrepById(db(), 'st-midsize'))!.imageContentHash).toBe(await sha256Of(mid));
  });

  it('downscales an over-cap image via the injected downscaler', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-down', imageUrl: 'https://img.example/huge.png' });
    const huge = new Uint8Array(600 * 1024); // over the 512 KB cap
    huge.set(PNG_BYTES);
    let calls = 0;
    const downscale: ImageDownscaler = async () => {
      calls++;
      return { bytes: toArrayBuffer(WEBP_BYTES), contentType: 'image/webp' };
    };
    const fetchImpl = (async () => imageResponse(huge)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, downscale });
    expect(r.stored).toBe(1);
    expect(calls).toBe(1);
    const hash = await sha256Of(WEBP_BYTES);
    const obj = await bucket().get(AVATAR_KEY_PREFIX + hash);
    expect(obj!.httpMetadata?.contentType).toBe('image/webp');
    expect((await getDrepById(db(), 'st-down'))!.imageContentHash).toBe(hash);
  });

  it('fails an over-cap image when no downscaler is configured', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-nodown', imageUrl: 'https://img.example/huge2.png' });
    const huge = new Uint8Array(600 * 1024);
    huge.set(PNG_BYTES);
    const fetchImpl = (async () => imageResponse(huge)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-nodown'))!.imageContentHash).toBeNull();
  });

  it('rejects a body over the hard download ceiling before downscaling', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-ceiling', imageUrl: 'https://img.example/ceil.png' });
    const over = new Uint8Array(10 * 1024 * 1024 + 1);
    over.set(PNG_BYTES);
    let calls = 0;
    const downscale: ImageDownscaler = async () => {
      calls++;
      return { bytes: toArrayBuffer(WEBP_BYTES), contentType: 'image/webp' };
    };
    const fetchImpl = (async () => imageResponse(over)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, downscale });
    expect(r.failed).toBe(1);
    expect(calls).toBe(0);
    expect((await getDrepById(db(), 'st-ceiling'))!.imageContentHash).toBeNull();
  });

  it('rejects an oversize content-length declaration before reading the body', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-declared', imageUrl: 'https://img.example/declared.png' });
    // Small body, but the declared length exceeds the hard ceiling: early reject fires.
    const fetchImpl = (async () =>
      new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024 + 1) },
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

// Inline base64 data: URI helper for the data-URI avatar path.
function dataUri(bytes: Uint8Array, mime = 'image/png'): string {
  return `data:${mime};base64,${btoa(String.fromCharCode(...bytes))}`;
}

describe('decodeDataUriImage', () => {
  it('decodes a base64 png data URI to bytes and type', () => {
    const decoded = decodeDataUriImage(dataUri(PNG_BYTES));
    expect(decoded).not.toBeNull();
    expect(new Uint8Array(decoded!.bytes)).toEqual(PNG_BYTES);
    expect(decoded!.contentType).toBe('image/png');
  });

  it('decodes a jpeg data URI, lowercasing the declared type', () => {
    const decoded = decodeDataUriImage(dataUri(PNG_BYTES, 'IMAGE/JPEG'));
    expect(decoded?.contentType).toBe('image/jpeg');
  });

  it('rejects an svg data URI (can carry scripts)', () => {
    expect(decodeDataUriImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeNull();
  });

  it('rejects a non-data string', () => {
    expect(decodeDataUriImage('https://example.com/x.png')).toBeNull();
  });

  it('rejects a non-base64 data URI', () => {
    expect(decodeDataUriImage('data:image/png,not-base64-payload')).toBeNull();
  });

  it('rejects an empty payload', () => {
    expect(decodeDataUriImage('data:image/png;base64,')).toBeNull();
  });

  it('rejects an unknown media type', () => {
    expect(decodeDataUriImage(dataUri(PNG_BYTES, 'image/tiff'))).toBeNull();
  });
});

describe('ingestDataUriAvatar', () => {
  it('stores the decoded bytes at avatars/<sha256> and returns the hash', async () => {
    const hash = await ingestDataUriAvatar(bucket(), dataUri(PNG_BYTES));
    expect(hash).toBe(await sha256Of(PNG_BYTES));

    const obj = await bucket().get(AVATAR_KEY_PREFIX + hash);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata?.contentType).toBe('image/png');
  });

  it('returns null for an svg data URI without storing anything', async () => {
    const hash = await ingestDataUriAvatar(bucket(), 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
    expect(hash).toBeNull();
  });
});

it('gc keeps objects referenced via extraReferenced', async () => {
  const b = bucket();
  await b.put(`${AVATAR_KEY_PREFIX}poolhash1`, new Uint8Array([1]).buffer);
  // No dreps row references it; without extraReferenced it would be deleted after grace.
  const farFuture = Date.now() + 1000 * 60 * 60 * 24 * 365;
  const res = await gcDrepAvatars({
    db: env.DB, bucket: b, nowMs: farFuture, extraReferenced: new Set(['poolhash1']),
  });
  expect(res.deleted).toBe(0);
  const obj = await b.get(`${AVATAR_KEY_PREFIX}poolhash1`);
  expect(obj).not.toBeNull();
});
