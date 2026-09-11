import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getGovActionMetadata,
  putGovActionMetadata,
  getCollectablePins,
  countCollectablePins,
  markPinDeleting,
  releasePinDeleting,
  deleteGovActionMetadata,
} from './govActionMetadata.js';

const NOW = 1_800_000_000;
const DAY = 86_400;
const GRACE = 7 * DAY;
const cutoff = (now: number) => now - GRACE;
const opts = (now: number, limit = 200) => ({ graceCutoff: cutoff(now), maxAttempts: 5, limit });

/** A row old enough to be collectable, unless something holds it back. */
async function insertOld(hash: string, over: { fileId?: string | null; servedAt?: number } = {}) {
  await putGovActionMetadata(env.DB, {
    hash,
    cid: `cid-${hash.slice(0, 4)}`,
    body: '{}',
    createdAt: over.servedAt ?? NOW - GRACE - DAY,
    pinataFileId: over.fileId === undefined ? `file-${hash.slice(0, 4)}` : over.fileId,
  });
}

describe('govActionMetadata', () => {
  it('stores and reads back a row, deduping on hash', async () => {
    const hash = 'a'.repeat(64);
    expect(await getGovActionMetadata(env.DB, hash, NOW)).toBeNull();
    await putGovActionMetadata(env.DB, { hash, cid: 'bafy1', body: '{"x":1}', createdAt: 1 });
    expect((await getGovActionMetadata(env.DB, hash, NOW))?.cid).toBe('bafy1');
    // INSERT OR IGNORE: a second put with a different cid does not overwrite.
    await putGovActionMetadata(env.DB, { hash, cid: 'bafy2', body: '{"x":1}', createdAt: 2 });
    expect((await getGovActionMetadata(env.DB, hash, NOW))?.cid).toBe('bafy1');
  });

  it('serving a row restarts its grace period', async () => {
    const hash = 'b'.repeat(64);
    await insertOld(hash);
    expect(await getCollectablePins(env.DB, opts(NOW))).toHaveLength(1);
    // A resubmission hands the CID back, which must protect the pin.
    await getGovActionMetadata(env.DB, hash, NOW);
    expect(await getCollectablePins(env.DB, opts(NOW))).toHaveLength(0);
  });

  it('never offers a row with no file id of ours', async () => {
    await insertOld('c'.repeat(64), { fileId: null });
    expect(await getCollectablePins(env.DB, opts(NOW))).toHaveLength(0);
  });

  it('never offers a row still inside the grace window', async () => {
    await insertOld('d'.repeat(64), { servedAt: NOW - DAY });
    expect(await getCollectablePins(env.DB, opts(NOW))).toHaveLength(0);
  });

  it('never offers a row whose document is anchored on chain', async () => {
    const hash = 'e'.repeat(64);
    await insertOld(hash);
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, anchor_hash, anchor_status, status, meta_version, topic_id, created_at, last_synced_at)
       VALUES (?, 'InfoAction', ?, 'ok', 'active', 5, 'topic-e', 1, 1)`,
    )
      .bind('tx-e#0', hash)
      .run();
    expect(await getCollectablePins(env.DB, opts(NOW))).toHaveLength(0);
  });

  // Pinata deduplicates by content, so one file id can back more than one row.
  // Deleting it while any sharer is still protected would break that sharer.
  it('holds back a row whose file id is shared with a protected row', async () => {
    const shared = 'file-shared';
    await putGovActionMetadata(env.DB, {
      hash: 'f'.repeat(64),
      cid: 'cid-f',
      body: '{}',
      createdAt: NOW - GRACE - DAY,
      pinataFileId: shared,
    });
    await putGovActionMetadata(env.DB, {
      hash: '9'.repeat(64),
      cid: 'cid-9',
      body: '{}',
      createdAt: NOW - DAY, // still inside its own grace window
      pinataFileId: shared,
    });
    expect(await getCollectablePins(env.DB, opts(NOW))).toHaveLength(0);
  });

  it('claims a row once, so two overlapping runs cannot both delete it', async () => {
    const hash = '1'.repeat(64);
    await insertOld(hash);
    expect(await markPinDeleting(env.DB, hash, NOW)).toBe(true);
    expect(await markPinDeleting(env.DB, hash, NOW)).toBe(false);
    // A claimed row is neither offered again nor served to a resubmission.
    expect(await getCollectablePins(env.DB, opts(NOW))).toHaveLength(0);
    expect(await getGovActionMetadata(env.DB, hash, NOW)).toBeNull();
  });

  it('releasing a claim counts the attempt and eventually drops the row', async () => {
    const hash = '2'.repeat(64);
    await insertOld(hash);
    for (let i = 0; i < 5; i++) {
      expect(await markPinDeleting(env.DB, hash, NOW)).toBe(true);
      await releasePinDeleting(env.DB, hash);
    }
    // maxAttempts is 5, so the poison row is out of the selection now.
    expect(await getCollectablePins(env.DB, opts(NOW))).toHaveLength(0);
  });

  it('a full batch of failing rows does not starve the ones behind them', async () => {
    const poison = '3'.repeat(63);
    for (let i = 0; i < 3; i++) {
      const hash = `${poison}${i}`;
      await insertOld(hash);
      await markPinDeleting(env.DB, hash, NOW);
      await releasePinDeleting(env.DB, hash);
    }
    const fresh = '4'.repeat(64);
    await insertOld(fresh);
    // Fewest attempts first, so the untried row is picked before the failures.
    const picked = await getCollectablePins(env.DB, opts(NOW, 1));
    expect(picked.map((p) => p.hash)).toEqual([fresh]);
  });

  it('counts the backlog and drops the row once its pin is gone', async () => {
    const hash = '5'.repeat(64);
    await insertOld(hash);
    expect(await countCollectablePins(env.DB, { graceCutoff: cutoff(NOW), maxAttempts: 5 })).toBe(1);
    await deleteGovActionMetadata(env.DB, hash);
    expect(await countCollectablePins(env.DB, { graceCutoff: cutoff(NOW), maxAttempts: 5 })).toBe(0);
    expect(await getGovActionMetadata(env.DB, hash, NOW)).toBeNull();
  });
});
