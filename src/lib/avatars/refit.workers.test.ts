// Refit backfill tests; run in workerd with the real miniflare R2 binding
// (AVATARS) and D1. The image transform is injected.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { refitStoredAvatars, type RefitTable } from './refit.js';
import { AVATAR_KEY_PREFIX, type ImageDownscaler } from '../dreps/avatarStore.js';
import {
  upsertDrep,
  getDrepById,
  setDrepImageStored,
  listDrepImageHashesNeedingFit,
  markDrepImageFitChecked,
  repointDrepImageHash,
} from '../db/dreps.js';
import { bytesToHex } from '../crypto/hex.js';
import { toArrayBuffer } from '../crypto/bytes.js';

const db = () => env.DB;
const bucket = () => env.AVATARS as R2Bucket;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
// Stand-in for the transform's output; the real bytes come from the Images binding.
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9, 9]);

const DREP_TABLE: RefitTable = {
  listPending: listDrepImageHashesNeedingFit,
  markChecked: markDrepImageFitChecked,
  repoint: repointDrepImageHash,
};

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

async function sha256Of(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/** Bytes over AVATAR_REFIT_ABOVE_BYTES, standing in for a full-resolution source. */
function oversized(fill: number): Uint8Array {
  const b = new Uint8Array(200 * 1024);
  b.set(PNG_BYTES);
  b[b.length - 1] = fill;
  return b;
}

/** A transform that records its call count, so "never read" is testable. */
function countingDownscale(out: { bytes: ArrayBuffer; contentType: string } | null) {
  const state = { calls: 0 };
  const fn: ImageDownscaler = async () => {
    state.calls++;
    return out;
  };
  return { state, fn };
}

const toWebp = () => countingDownscale({ bytes: toArrayBuffer(WEBP_BYTES), contentType: 'image/webp' });

/**
 * Stores an object and points a DRep row at it, leaving the row in the refit
 * queue (setDrepImageStored would stamp it as already measured).
 */
async function pending(drepId: string, bytes: Uint8Array, contentType = 'image/png'): Promise<string> {
  const hash = await sha256Of(bytes);
  await bucket().put(AVATAR_KEY_PREFIX + hash, toArrayBuffer(bytes), { httpMetadata: { contentType } });
  await upsertDrep(db(), {
    ...BASE,
    drepId,
    imageUrl: `https://img.example/${drepId}.png`,
    imageContentHash: hash,
    imageStoredUrl: `https://img.example/${drepId}.png`,
  });
  return hash;
}

const run = (downscale: ImageDownscaler | undefined, limit?: number) =>
  refitStoredAvatars({ db: db(), bucket: bucket(), tables: [DREP_TABLE], downscale, limit });

describe('refitStoredAvatars', () => {
  it('rewrites an oversized object and moves its rows to the new hash', async () => {
    const bytes = oversized(1);
    const oldHash = await pending('rf-drep', bytes);
    const d = toWebp();

    const r = await run(d.fn);

    expect(r.refitted).toBe(1);
    expect(r.savedBytes).toBe(bytes.byteLength - WEBP_BYTES.byteLength);
    const newHash = await sha256Of(WEBP_BYTES);
    expect((await getDrepById(db(), 'rf-drep'))!.imageContentHash).toBe(newHash);
    expect((await bucket().get(AVATAR_KEY_PREFIX + newHash))!.httpMetadata?.contentType).toBe('image/webp');
    // The old object survives the pass; the GC reaps it once it is unreferenced.
    expect(await bucket().head(AVATAR_KEY_PREFIX + oldHash)).not.toBeNull();
  });

  it('drains: a refitted row does not come back on the next run', async () => {
    await pending('rf-drain', oversized(2));
    const first = toWebp();
    expect((await run(first.fn)).refitted).toBe(1);

    const second = toWebp();
    const r = await run(second.fn);

    expect(r).toMatchObject({ scanned: 0, refitted: 0 });
    expect(second.state.calls).toBe(0);
  });

  it('stamps an object it cannot improve, so it is considered once', async () => {
    const hash = await pending('rf-nogain', oversized(3));
    const noGain = countingDownscale(null);

    expect((await run(noGain.fn)).refitted).toBe(0);
    expect(noGain.state.calls).toBe(1);

    const second = countingDownscale(null);
    expect((await run(second.fn)).scanned).toBe(0);
    expect(second.state.calls).toBe(0);
    // Kept objects keep their bytes, their content type, and their row.
    const obj = await bucket().get(AVATAR_KEY_PREFIX + hash);
    expect(obj!.httpMetadata?.contentType).toBe('image/png');
    expect((await obj!.arrayBuffer()).byteLength).toBe(200 * 1024);
    expect((await getDrepById(db(), 'rf-nogain'))!.imageContentHash).toBe(hash);
  });

  it('never reads a GIF, so an animation survives untouched', async () => {
    const gif = new Uint8Array(200 * 1024);
    gif.set([0x47, 0x49, 0x46, 0x38]);
    gif[gif.length - 1] = 4;
    const hash = await pending('rf-gif', gif, 'image/gif');
    const d = toWebp();

    const r = await run(d.fn);

    expect(d.state.calls).toBe(0);
    expect(r.refitted).toBe(0);
    const obj = await bucket().get(AVATAR_KEY_PREFIX + hash);
    expect(obj!.httpMetadata?.contentType).toBe('image/gif');
    expect((await obj!.arrayBuffer()).byteLength).toBe(gif.byteLength);
    expect((await getDrepById(db(), 'rf-gif'))!.imageContentHash).toBe(hash);
  });

  it('leaves objects under the threshold alone without reading them', async () => {
    const hash = await pending('rf-small', PNG_BYTES);
    const d = toWebp();

    await run(d.fn);

    expect(d.state.calls).toBe(0);
    expect(await bucket().head(AVATAR_KEY_PREFIX + hash)).not.toBeNull();
    expect((await getDrepById(db(), 'rf-small'))!.imageContentHash).toBe(hash);
  });

  it('stamps a hash whose object is gone instead of retrying it forever', async () => {
    await upsertDrep(db(), {
      ...BASE,
      drepId: 'rf-dangling',
      imageUrl: 'https://img.example/gone.png',
      imageContentHash: 'd'.repeat(64),
      imageStoredUrl: 'https://img.example/gone.png',
    });
    const d = toWebp();

    expect((await run(d.fn)).scanned).toBe(1);
    expect(d.state.calls).toBe(0);
    expect((await run(toWebp().fn)).scanned).toBe(0);
  });

  it('does nothing without a transform, leaving the queue intact', async () => {
    await pending('rf-nodown', oversized(5));

    expect(await run(undefined)).toMatchObject({ scanned: 0, refitted: 0 });
    expect(await listDrepImageHashesNeedingFit(db(), 10)).toContain(await sha256Of(oversized(5)));
  });

  it('stops at the per-run limit so the backlog drains over runs', async () => {
    for (const fill of [6, 7, 8]) await pending(`rf-limit-${fill}`, oversized(fill));

    expect((await run(toWebp().fn, 2)).scanned).toBe(2);
  });

  it('considers an object shared by several rows once and moves them together', async () => {
    const bytes = oversized(9);
    const hash = await sha256Of(bytes);
    await bucket().put(AVATAR_KEY_PREFIX + hash, toArrayBuffer(bytes), {
      httpMetadata: { contentType: 'image/png' },
    });
    for (const id of ['rf-shared-a', 'rf-shared-b']) {
      await upsertDrep(db(), {
        ...BASE,
        drepId: id,
        imageUrl: `https://img.example/${id}.png`,
        imageContentHash: hash,
        imageStoredUrl: `https://img.example/${id}.png`,
      });
    }
    const d = toWebp();

    const r = await run(d.fn);

    expect(d.state.calls).toBe(1);
    expect(r.refitted).toBe(1);
    const newHash = await sha256Of(WEBP_BYTES);
    expect((await getDrepById(db(), 'rf-shared-a'))!.imageContentHash).toBe(newHash);
    expect((await getDrepById(db(), 'rf-shared-b'))!.imageContentHash).toBe(newHash);
    // Both rows are stamped, so neither returns to the queue.
    expect((await run(toWebp().fn)).scanned).toBe(0);
  });

  it('stamps a newly stored avatar so the backfill never looks at it', async () => {
    const url = 'https://img.example/fresh.png';
    await upsertDrep(db(), { ...BASE, drepId: 'rf-fresh', imageUrl: url });
    await setDrepImageStored(db(), 'rf-fresh', await sha256Of(PNG_BYTES), url);

    expect(await listDrepImageHashesNeedingFit(db(), 10)).not.toContain(await sha256Of(PNG_BYTES));
  });
});
