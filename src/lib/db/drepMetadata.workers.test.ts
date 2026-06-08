// DRep metadata D1 access tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises the content-addressed putDrepMetadata / getDrepMetadataByHash and GC
// against the real miniflare D1 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { putDrepMetadata, getDrepMetadataByHash, gcDrepMetadata } from './drepMetadata.js';

const db = () => env.DB;

const NOW = 1_748_000_000;

// Fixture values: a realistic CIP-129 drep id and matching JSON + hash.
const DREP_ID = 'drep1yyqw67szjkwns4vfqvnk0v8r20zy5qmv3hge2qlxm0s3apgsp3qsk6j5t4';
const BODY = JSON.stringify({ '@context': 'https://github.com/cardano-foundation/CIPs/tree/master/CIP-0119', name: 'Test DRep', bio: 'Hello' });
const HASH = 'a'.repeat(64); // 64 hex chars, placeholder for blake2b-256 output
const NAME = 'Test DRep';

describe('putDrepMetadata + getDrepMetadataByHash', () => {
  it('inserts a row and reads it back by (drepId, hash) with all fields intact', async () => {
    await putDrepMetadata(db(), { drepId: DREP_ID, body: BODY, hash: HASH, name: NAME, createdAt: NOW });

    const result = await getDrepMetadataByHash(db(), DREP_ID, HASH);

    expect(result).not.toBeNull();
    expect(result!.drepId).toBe(DREP_ID);
    // body must round-trip exactly, byte-for-byte (it is hashed on-chain).
    expect(result!.body).toBe(BODY);
    expect(result!.hash).toBe(HASH);
    expect(result!.name).toBe(NAME);
    expect(result!.createdAt).toBe(NOW);
  });

  it('returns null for an unknown (drepId, hash)', async () => {
    expect(await getDrepMetadataByHash(db(), DREP_ID, 'b'.repeat(64))).toBeNull();
    expect(await getDrepMetadataByHash(db(), 'drep1-does-not-exist', HASH)).toBeNull();
  });

  it('is content-addressed: re-posting identical content is an idempotent no-op', async () => {
    const drepId = `${DREP_ID}-idem`;
    await putDrepMetadata(db(), { drepId, body: BODY, hash: HASH, name: NAME, createdAt: NOW });
    // A second write of the SAME content (same hash) must not overwrite or error,
    // and must not change the stored created_at.
    await putDrepMetadata(db(), { drepId, body: BODY, hash: HASH, name: 'Tampered', createdAt: NOW + 9999 });

    const result = await getDrepMetadataByHash(db(), drepId, HASH);
    expect(result!.name).toBe(NAME); // original kept (INSERT OR IGNORE)
    expect(result!.createdAt).toBe(NOW);
  });

  it('lets two different documents for the same drep id coexist (no clobber)', async () => {
    const drepId = `${DREP_ID}-coexist`;
    const bodyA = '{"v":1}';
    const hashA = '1'.repeat(64);
    const bodyB = '{"v":2}';
    const hashB = '2'.repeat(64);
    await putDrepMetadata(db(), { drepId, body: bodyA, hash: hashA, name: 'A', createdAt: NOW });
    await putDrepMetadata(db(), { drepId, body: bodyB, hash: hashB, name: 'B', createdAt: NOW + 1 });

    expect((await getDrepMetadataByHash(db(), drepId, hashA))!.body).toBe(bodyA);
    expect((await getDrepMetadataByHash(db(), drepId, hashB))!.body).toBe(bodyB);
  });
});

describe('gcDrepMetadata', () => {
  it('deletes only old rows that are neither a registered drep nor a referenced hash', async () => {
    const OLD = 1000;
    const RECENT = 1_000_000;
    const THRESHOLD = 500_000;

    const registeredId = 'gc-registered-drep';
    const referencedId = 'gc-referenced-junk-id';
    const referencedHash = 'c'.repeat(64);
    const junkId = 'gc-pure-junk-id';
    const junkHash = 'e'.repeat(64);
    const recentJunkId = 'gc-recent-junk-id';

    // A: registered drep, old -> kept (registered)
    await putDrepMetadata(db(), { drepId: registeredId, body: '{}', hash: 'd'.repeat(64), name: 'A', createdAt: OLD });
    // B: junk id but its hash is a current on-chain anchor, old -> kept (referenced)
    await putDrepMetadata(db(), { drepId: referencedId, body: '{}', hash: referencedHash, name: 'B', createdAt: OLD });
    // C: pure junk, old -> deleted
    await putDrepMetadata(db(), { drepId: junkId, body: '{}', hash: junkHash, name: 'C', createdAt: OLD });
    // D: pure junk but recent (within grace) -> kept
    await putDrepMetadata(db(), { drepId: recentJunkId, body: '{}', hash: 'f'.repeat(64), name: 'D', createdAt: RECENT });

    const result = await gcDrepMetadata(db(), {
      registeredIds: new Set([registeredId]),
      keepHashes: new Set([referencedHash]),
      olderThanSec: THRESHOLD,
    });

    expect(result.deleted).toBe(1);
    expect(await getDrepMetadataByHash(db(), registeredId, 'd'.repeat(64))).not.toBeNull();
    expect(await getDrepMetadataByHash(db(), referencedId, referencedHash)).not.toBeNull();
    expect(await getDrepMetadataByHash(db(), junkId, junkHash)).toBeNull();
    expect(await getDrepMetadataByHash(db(), recentJunkId, 'f'.repeat(64))).not.toBeNull();
  });

  it('deletes only the junk row of an unregistered drep id, keeping its referenced-hash row', async () => {
    const id = 'gc-mixed-unregistered';
    const keptHash = '3'.repeat(64);
    const junkHash = '4'.repeat(64);
    await putDrepMetadata(db(), { drepId: id, body: '{"keep":1}', hash: keptHash, name: 'keep', createdAt: 100 });
    await putDrepMetadata(db(), { drepId: id, body: '{"junk":1}', hash: junkHash, name: 'junk', createdAt: 100 });

    const result = await gcDrepMetadata(db(), {
      registeredIds: new Set(), // id is NOT registered
      keepHashes: new Set([keptHash]), // but one of its hashes is on-chain
      olderThanSec: 500_000,
    });

    expect(result.deleted).toBe(1);
    expect(await getDrepMetadataByHash(db(), id, keptHash)).not.toBeNull(); // referenced row kept
    expect(await getDrepMetadataByHash(db(), id, junkHash)).toBeNull(); // junk row deleted
  });
});
