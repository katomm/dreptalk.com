// DRep metadata D1 access tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises putDrepMetadata and getDrepMetadata against the real miniflare D1 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { putDrepMetadata, getDrepMetadata, gcDrepMetadata } from './drepMetadata.js';

const db = () => env.DB;

const NOW = 1_748_000_000;

// Fixture values: a realistic CIP-129 drep id and matching JSON + hash.
const DREP_ID = 'drep1yyqw67szjkwns4vfqvnk0v8r20zy5qmv3hge2qlxm0s3apgsp3qsk6j5t4';
const BODY = JSON.stringify({ '@context': 'https://github.com/cardano-foundation/CIPs/tree/master/CIP-0119', name: 'Test DRep', bio: 'Hello' });
const HASH = 'a'.repeat(64); // 64 hex chars, placeholder for blake2b-256 output
const NAME = 'Test DRep';

describe('putDrepMetadata + getDrepMetadata', () => {
  it('inserts a row and reads it back with all fields intact', async () => {
    await putDrepMetadata(db(), {
      drepId: DREP_ID,
      body: BODY,
      hash: HASH,
      name: NAME,
      createdAt: NOW,
    });

    const result = await getDrepMetadata(db(), DREP_ID);

    expect(result).not.toBeNull();
    expect(result!.drepId).toBe(DREP_ID);
    // body must round-trip exactly, byte-for-byte.
    expect(result!.body).toBe(BODY);
    // hash must round-trip exactly.
    expect(result!.hash).toBe(HASH);
    expect(result!.name).toBe(NAME);
    expect(result!.createdAt).toBe(NOW);
  });

  it('returns null for an unknown drep id', async () => {
    const result = await getDrepMetadata(db(), 'drep1-definitely-does-not-exist-xyz');
    expect(result).toBeNull();
  });

  it('INSERT OR REPLACE overwrites an existing row', async () => {
    const drepId = `${DREP_ID}-replace-test`;
    await putDrepMetadata(db(), {
      drepId,
      body: BODY,
      hash: HASH,
      name: NAME,
      createdAt: NOW,
    });

    const newBody = JSON.stringify({ name: 'Updated DRep', version: 2 });
    const newHash = 'b'.repeat(64);
    await putDrepMetadata(db(), {
      drepId,
      body: newBody,
      hash: newHash,
      name: 'Updated DRep',
      createdAt: NOW + 3600,
    });

    const result = await getDrepMetadata(db(), drepId);
    expect(result).not.toBeNull();
    expect(result!.body).toBe(newBody);
    expect(result!.hash).toBe(newHash);
    expect(result!.name).toBe('Updated DRep');
    expect(result!.createdAt).toBe(NOW + 3600);
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
    const recentJunkId = 'gc-recent-junk-id';

    // A: registered drep, old -> kept (registered)
    await putDrepMetadata(db(), { drepId: registeredId, body: '{}', hash: 'd'.repeat(64), name: 'A', createdAt: OLD });
    // B: junk id but its hash is a current on-chain anchor, old -> kept (referenced)
    await putDrepMetadata(db(), { drepId: referencedId, body: '{}', hash: referencedHash, name: 'B', createdAt: OLD });
    // C: pure junk, old -> deleted
    await putDrepMetadata(db(), { drepId: junkId, body: '{}', hash: 'e'.repeat(64), name: 'C', createdAt: OLD });
    // D: pure junk but recent (within grace) -> kept
    await putDrepMetadata(db(), { drepId: recentJunkId, body: '{}', hash: 'f'.repeat(64), name: 'D', createdAt: RECENT });

    const result = await gcDrepMetadata(db(), {
      registeredIds: new Set([registeredId]),
      keepHashes: new Set([referencedHash]),
      olderThanSec: THRESHOLD,
    });

    expect(result.deleted).toBe(1);
    expect(await getDrepMetadata(db(), registeredId)).not.toBeNull();
    expect(await getDrepMetadata(db(), referencedId)).not.toBeNull();
    expect(await getDrepMetadata(db(), junkId)).toBeNull();
    expect(await getDrepMetadata(db(), recentJunkId)).not.toBeNull();
  });

  it('deletes nothing when every old row is registered or referenced', async () => {
    const id = 'gc-allkept-registered';
    await putDrepMetadata(db(), { drepId: id, body: '{}', hash: 'a1'.repeat(32), name: 'X', createdAt: 100 });
    const result = await gcDrepMetadata(db(), {
      registeredIds: new Set([id]),
      keepHashes: new Set(),
      olderThanSec: 500_000,
    });
    expect(result.deleted).toBe(0);
    expect(await getDrepMetadata(db(), id)).not.toBeNull();
  });
});
