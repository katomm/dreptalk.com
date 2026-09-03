// Avatar store tests; run in workerd with the real miniflare R2 binding
// (AVATARS) and D1. The image fetch is injected.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  storeDrepAvatars,
  gcDrepAvatars,
  refitStoredAvatars,
  decodeDataUriImage,
  ingestDataUriAvatar,
  AVATAR_KEY_PREFIX,
  ogAvatarKey,
  type ImageDownscaler,
} from './avatarStore.js';
import {
  upsertDrep,
  getDrepById,
  listDrepsNeedingAvatar,
  countGivenUpAvatars,
  setDrepImageStored,
} from '../db/dreps.js';
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
  profileExtractVersion: 0,
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

  it('stores an image under the refit threshold as-is, without a transform', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-small', imageUrl: 'https://img.example/small.png' });
    // 20 KB: under AVATAR_REFIT_ABOVE_BYTES, so the source bytes are kept.
    const small = new Uint8Array(20 * 1024);
    small.set(PNG_BYTES);
    let downscaleCalls = 0;
    const downscale: ImageDownscaler = async () => {
      downscaleCalls++;
      return null;
    };
    const fetchImpl = (async () => imageResponse(small)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, downscale });
    expect(r.stored).toBe(1);
    expect(downscaleCalls).toBe(0);
    expect((await getDrepById(db(), 'st-small'))!.imageContentHash).toBe(await sha256Of(small));
  });

  it('refits an image over the threshold even though it is under the hard cap', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-midsize', imageUrl: 'https://img.example/mid.png' });
    // 300 KB: well under the 512 KB hard cap, but far more resolution than any
    // avatar slot renders, so it is refitted rather than stored as it arrived.
    const mid = new Uint8Array(300 * 1024);
    mid.set(PNG_BYTES);
    let downscaleCalls = 0;
    const downscale: ImageDownscaler = async () => {
      downscaleCalls++;
      return { bytes: toArrayBuffer(WEBP_BYTES), contentType: 'image/webp' };
    };
    const fetchImpl = (async () => imageResponse(mid)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, downscale });
    expect(r.stored).toBe(1);
    expect(downscaleCalls).toBe(1);
    expect((await getDrepById(db(), 'st-midsize'))!.imageContentHash).toBe(await sha256Of(WEBP_BYTES));
  });

  it('keeps the source when the transform comes back no smaller', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-nogain', imageUrl: 'https://img.example/packed.png' });
    // A well packed source: the WebP re-encode loses, so the source is kept.
    const packed = new Uint8Array(30 * 1024);
    packed.set(PNG_BYTES);
    const bigger = new Uint8Array(40 * 1024);
    const downscale: ImageDownscaler = async () => ({ bytes: toArrayBuffer(bigger), contentType: 'image/webp' });
    const fetchImpl = (async () => imageResponse(packed)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, downscale });
    expect(r.stored).toBe(1);
    expect((await getDrepById(db(), 'st-nogain'))!.imageContentHash).toBe(await sha256Of(packed));
  });

  it('stores an oversized image as-is when no transform is available', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-nofit', imageUrl: 'https://img.example/nofit.png' });
    // Over the refit threshold but under the hard cap: without a downscaler the
    // source is still perfectly storable, so it must not be rejected.
    const mid = new Uint8Array(300 * 1024);
    mid.set(PNG_BYTES);
    const fetchImpl = (async () => imageResponse(mid)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.stored).toBe(1);
    expect((await getDrepById(db(), 'st-nofit'))!.imageContentHash).toBe(await sha256Of(mid));
  });

  it('keeps a GIF unconverted so an animation survives', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-gif', imageUrl: 'https://img.example/anim.gif' });
    // Over the refit threshold, but converting to WebP would drop every frame
    // after the first, and the source is storable as it stands.
    const gif = new Uint8Array(60 * 1024);
    gif.set([0x47, 0x49, 0x46, 0x38]);
    let downscaleCalls = 0;
    const downscale: ImageDownscaler = async () => {
      downscaleCalls++;
      return { bytes: toArrayBuffer(WEBP_BYTES), contentType: 'image/webp' };
    };
    const fetchImpl = (async () => imageResponse(gif, 'image/gif')) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl, downscale });
    expect(r.stored).toBe(1);
    expect(downscaleCalls).toBe(0);
    const row = await getDrepById(db(), 'st-gif');
    expect(row!.imageContentHash).toBe(await sha256Of(gif));
    expect((await bucket().get(AVATAR_KEY_PREFIX + row!.imageContentHash))!.httpMetadata?.contentType).toBe('image/gif');
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

  it('deletes an orphaned PNG rendition alongside its avatar, keeps a referenced one', async () => {
    const keepHash = '6'.repeat(64);
    const dropHash = '7'.repeat(64);
    await upsertDrep(db(), { ...BASE, drepId: 'gc-rendition', imageUrl: 'https://img.example/k.webp', imageContentHash: keepHash, imageStoredUrl: 'https://img.example/k.webp' });
    await bucket().put(ogAvatarKey(keepHash), PNG_BYTES);
    await bucket().put(ogAvatarKey(dropHash), PNG_BYTES);

    const r = await gcDrepAvatars({ db: db(), bucket: bucket(), nowMs: Date.now() + 25 * 60 * 60 * 1000 });
    expect(r.deleted).toBe(1);
    expect(await bucket().get(ogAvatarKey(keepHash))).not.toBeNull();
    expect(await bucket().get(ogAvatarKey(dropHash))).toBeNull();
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

// Image URLs pointing at our own zone can never be fetched from a Worker (the
// same-zone subrequest blackholes at the placeholder origin). A self-hosted
// /api/avatar/<hash> URL means the bytes are ALREADY in our R2 bucket, so the
// pass adopts the hash directly; any other self-zone URL fails immediately.
describe('storeDrepAvatars self-hosted image URLs', () => {
  const throwingFetch: typeof fetch = async (input) => {
    throw new Error('HTTP fetch attempted: ' + String(input));
  };

  it('adopts an /api/avatar/<hash> URL from R2 without any HTTP fetch', async () => {
    const hash = await sha256Of(PNG_BYTES);
    await bucket().put(AVATAR_KEY_PREFIX + hash, PNG_BYTES, { httpMetadata: { contentType: 'image/png' } });
    const url = `https://dreptalk.com/api/avatar/${hash}`;
    await upsertDrep(db(), { ...BASE, drepId: 'st-self-adopt', imageUrl: url });

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl: throwingFetch });

    expect(r).toMatchObject({ stored: 1, failed: 0 });
    const row = await getDrepById(db(), 'st-self-adopt');
    expect(row!.imageContentHash).toBe(hash);
    expect(row!.imageStoredUrl).toBe(url);
  });

  it('fails an /api/avatar/<hash> URL whose object is missing, without HTTP', async () => {
    const url = `https://dreptalk.com/api/avatar/${'c'.repeat(64)}`;
    await upsertDrep(db(), { ...BASE, drepId: 'st-self-missing', imageUrl: url });

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl: throwingFetch });

    expect(r).toMatchObject({ stored: 0, failed: 1 });
    const row = await getDrepById(db(), 'st-self-missing');
    expect(row!.imageContentHash).toBeNull();
    expect(row!.imageFetchFailedAt).not.toBeNull();
  });

  it('fails any other self-zone image URL immediately, without HTTP', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-self-other', imageUrl: 'https://preprod.dreptalk.com/logo.png' });

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl: throwingFetch });

    expect(r).toMatchObject({ stored: 0, failed: 1 });
    expect((await getDrepById(db(), 'st-self-other'))!.imageFetchFailedAt).not.toBeNull();
  });
});

describe('refitStoredAvatars', () => {
  // Bytes over AVATAR_REFIT_ABOVE_BYTES, standing in for a stored full-resolution
  // source. The refitted output is the small WEBP_BYTES.
  const oversized = (fill: number): Uint8Array => {
    const b = new Uint8Array(200 * 1024);
    b.set(PNG_BYTES);
    b[b.length - 1] = fill;
    return b;
  };
  const toWebp: ImageDownscaler = async () => ({ bytes: toArrayBuffer(WEBP_BYTES), contentType: 'image/webp' });

  /** Puts an object and points a DRep row at it, so the pass considers it. */
  async function storedAndReferenced(
    drepId: string,
    bytes: Uint8Array,
    contentType = 'image/png',
  ): Promise<string> {
    const hash = await sha256Of(bytes);
    await bucket().put(AVATAR_KEY_PREFIX + hash, toArrayBuffer(bytes), { httpMetadata: { contentType } });
    const imageUrl = `https://img.example/${drepId}.png`;
    await upsertDrep(db(), { ...BASE, drepId, imageUrl });
    await setDrepImageStored(db(), drepId, hash, imageUrl);
    return hash;
  }

  it('rewrites an oversized object and moves its rows to the new hash', async () => {
    const bytes = oversized(1);
    const oldHash = await storedAndReferenced('rf-drep', bytes);

    const r = await refitStoredAvatars({ db: db(), bucket: bucket(), downscale: toWebp });

    expect(r.refitted).toBe(1);
    expect(r.savedBytes).toBe(bytes.byteLength - WEBP_BYTES.byteLength);
    const newHash = await sha256Of(WEBP_BYTES);
    expect((await getDrepById(db(), 'rf-drep'))!.imageContentHash).toBe(newHash);
    const obj = await bucket().get(AVATAR_KEY_PREFIX + newHash);
    expect(obj!.httpMetadata?.contentType).toBe('image/webp');
    // The old object survives the pass; the GC reaps it once it is unreferenced.
    expect(await bucket().head(AVATAR_KEY_PREFIX + oldHash)).not.toBeNull();
  });

  it('walks past an object nothing references anymore', async () => {
    // What a refit leaves behind: the rows have moved on, the GC has not run yet.
    // Transforming it again would be pure waste, and would recount its savings.
    const bytes = oversized(7);
    await bucket().put(AVATAR_KEY_PREFIX + (await sha256Of(bytes)), toArrayBuffer(bytes), {
      httpMetadata: { contentType: 'image/png' },
    });
    let calls = 0;
    const counting: ImageDownscaler = async () => {
      calls++;
      return { bytes: toArrayBuffer(WEBP_BYTES), contentType: 'image/webp' };
    };

    const r = await refitStoredAvatars({ db: db(), bucket: bucket(), downscale: counting });

    expect(calls).toBe(0);
    expect(r).toMatchObject({ scanned: 0, refitted: 0, kept: 0 });
  });

  it('marks an object it cannot improve so a second run skips it', async () => {
    const hash = await storedAndReferenced('rf-nogain', oversized(2));
    let calls = 0;
    const noGain: ImageDownscaler = async () => {
      calls++;
      return null;
    };

    const first = await refitStoredAvatars({ db: db(), bucket: bucket(), downscale: noGain });
    expect(first.kept).toBe(1);
    expect(calls).toBe(1);

    const second = await refitStoredAvatars({ db: db(), bucket: bucket(), downscale: noGain });
    expect(second.scanned).toBe(0);
    expect(calls).toBe(1);
    // Kept objects keep their bytes, their content type, and their row.
    const obj = await bucket().get(AVATAR_KEY_PREFIX + hash);
    expect(obj!.httpMetadata?.contentType).toBe('image/png');
    expect((await obj!.arrayBuffer()).byteLength).toBe(200 * 1024);
    expect((await getDrepById(db(), 'rf-nogain'))!.imageContentHash).toBe(hash);
  });

  it('keeps a GIF as it is, with its content type intact', async () => {
    // The marking re-put must carry the object's own content type through, or a
    // kept GIF would come back out of the bucket labelled as something else.
    const gif = new Uint8Array(200 * 1024);
    gif.set([0x47, 0x49, 0x46, 0x38]);
    gif[gif.length - 1] = 9;
    const hash = await storedAndReferenced('rf-gif', gif, 'image/gif');
    let calls = 0;
    const counting: ImageDownscaler = async () => {
      calls++;
      return { bytes: toArrayBuffer(WEBP_BYTES), contentType: 'image/webp' };
    };

    const r = await refitStoredAvatars({ db: db(), bucket: bucket(), downscale: counting });

    expect(calls).toBe(0);
    expect(r.kept).toBe(1);
    const obj = await bucket().get(AVATAR_KEY_PREFIX + hash);
    expect(obj!.httpMetadata?.contentType).toBe('image/gif');
    expect((await obj!.arrayBuffer()).byteLength).toBe(gif.byteLength);
  });

  it('leaves objects under the threshold untouched', async () => {
    const hash = await storedAndReferenced('rf-small', PNG_BYTES);
    let calls = 0;
    const counting: ImageDownscaler = async () => {
      calls++;
      return null;
    };

    await refitStoredAvatars({ db: db(), bucket: bucket(), downscale: counting });
    expect(calls).toBe(0);
    expect(await bucket().head(AVATAR_KEY_PREFIX + hash)).not.toBeNull();
    expect((await getDrepById(db(), 'rf-small'))!.imageContentHash).toBe(hash);
  });

  it('does nothing without a refitter', async () => {
    await storedAndReferenced('rf-nodown', oversized(3));
    expect(await refitStoredAvatars({ db: db(), bucket: bucket() })).toMatchObject({ scanned: 0, refitted: 0 });
  });

  it('stops at the per-run limit so the backlog drains over runs', async () => {
    for (const fill of [4, 5, 6]) await storedAndReferenced(`rf-limit-${fill}`, oversized(fill));

    const r = await refitStoredAvatars({ db: db(), bucket: bucket(), downscale: toWebp, limit: 2 });
    expect(r.scanned).toBe(2);
  });
});
