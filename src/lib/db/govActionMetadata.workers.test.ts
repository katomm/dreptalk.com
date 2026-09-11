import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  serveGovActionMetadata,
  putGovActionMetadata,
  getCollectablePins,
  markPinDeleting,
  releasePinDeleting,
  deleteGovActionMetadata,
} from './govActionMetadata.js';

const NOW = 1_800_000_000;
const DAY = 86_400;
const GRACE = 7 * DAY;
const cutoff = (now: number) => now - GRACE;
const HOUR = 3600;
const opts = (now: number, limit = 200) => ({
  graceCutoff: cutoff(now),
  staleClaimCutoff: now - HOUR,
  limit,
});
const claim = (hash: string, now = NOW) => markPinDeleting(env.DB, hash, now, now - HOUR);
const pins = async (now = NOW, limit = 200) => (await getCollectablePins(env.DB, opts(now, limit))).pins;

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
    expect(await serveGovActionMetadata(env.DB, hash, NOW)).toBeNull();
    await putGovActionMetadata(env.DB, { hash, cid: 'bafy1', body: '{"x":1}', createdAt: 1 });
    expect((await serveGovActionMetadata(env.DB, hash, NOW))?.cid).toBe('bafy1');
    // INSERT OR IGNORE: a second put with a different cid does not overwrite.
    await putGovActionMetadata(env.DB, { hash, cid: 'bafy2', body: '{"x":1}', createdAt: 2 });
    expect((await serveGovActionMetadata(env.DB, hash, NOW))?.cid).toBe('bafy1');
  });

  it('serving a row restarts its grace period', async () => {
    const hash = 'b'.repeat(64);
    await insertOld(hash);
    expect(await pins()).toHaveLength(1);
    // A resubmission hands the CID back, which must protect the pin.
    await serveGovActionMetadata(env.DB, hash, NOW);
    expect(await pins()).toHaveLength(0);
  });

  it('never offers a row with no file id of ours', async () => {
    await insertOld('c'.repeat(64), { fileId: null });
    expect(await pins()).toHaveLength(0);
  });

  it('never offers a row still inside the grace window', async () => {
    await insertOld('d'.repeat(64), { servedAt: NOW - DAY });
    expect(await pins()).toHaveLength(0);
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
    expect(await pins()).toHaveLength(0);
  });

  // A claim is a lease, not a lock. A run killed between claiming and finishing
  // would otherwise strand the row forever: never served, never re-selected.
  it('takes back a claim left behind by a run that died', async () => {
    const hash = 'f'.repeat(64);
    await insertOld(hash);
    // Claimed two hours ago by a run that never came back.
    expect(await claim(hash, NOW - 2 * HOUR)).toBe(true);
    expect(await pins()).toHaveLength(0 + 1);
    expect(await claim(hash)).toBe(true);
  });

  it('claims a row once, so two overlapping runs cannot both delete it', async () => {
    const hash = '1'.repeat(64);
    await insertOld(hash);
    expect(await claim(hash)).toBe(true);
    expect(await claim(hash)).toBe(false);
    // A claimed row is neither offered again nor served to a resubmission.
    expect(await pins()).toHaveLength(0);
    expect(await serveGovActionMetadata(env.DB, hash, NOW)).toBeNull();
  });

  it('keeps retrying a row that fails, rather than retiring it', async () => {
    const hash = '2'.repeat(64);
    await insertOld(hash);
    for (let i = 0; i < 8; i++) {
      expect(await claim(hash)).toBe(true);
      await releasePinDeleting(env.DB, hash);
    }
    // No attempt cutoff on purpose: a couple of hours of Pinata being down must
    // not retire a document for good. Ordering is what stops it blocking others.
    expect(await pins()).toHaveLength(1);
  });

  it('a full batch of failing rows does not starve the ones behind them', async () => {
    const poison = '3'.repeat(63);
    for (let i = 0; i < 3; i++) {
      const hash = `${poison}${i}`;
      await insertOld(hash);
      await claim(hash);
      await releasePinDeleting(env.DB, hash);
    }
    const fresh = '4'.repeat(64);
    await insertOld(fresh);
    // Fewest attempts first, so the untried row is picked before the failures.
    const picked = await pins(NOW, 1);
    expect(picked.map((p) => p.hash)).toEqual([fresh]);
  });

  it('reports the backlog from the same population it selects from', async () => {
    for (let i = 0; i < 3; i++) await insertOld(`${'5'.repeat(63)}${i}`);
    const page = await getCollectablePins(env.DB, opts(NOW, 1));
    expect(page.pins).toHaveLength(1);
    expect(page.total).toBe(3);
    await deleteGovActionMetadata(env.DB, page.pins[0].hash);
    expect((await getCollectablePins(env.DB, opts(NOW, 1))).total).toBe(2);
  });
});
