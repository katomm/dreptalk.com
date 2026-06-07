// DReps D1 access tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises upsertDrep, getDrepById, getDrepsByIds against the
// real miniflare D1 binding with all migrations applied.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getDrepById, getDrepsByIds, upsertDrep } from './dreps.js';

const db = () => env.DB;

const NOW = 1_748_000_000;

// Realistic CIP-129 DRep ids used as fixtures.
const DREP_A = 'drep1yyqw67szjkwns4vfqvnk0v8r20zy5qmv3hge2qlxm0s3apgsp3qsk6j5t4';
const DREP_B = 'drep1yydglhfzxwl5k3fjmg3fpe98jj59emqcscxmgv6e5mkstdfyqsxqy37ue6';

const BASE_ARGS = {
  drepId: DREP_A,
  hex: 'abc123',
  hasScript: false,
  status: 'active',
  active: true,
  deposit: '2000000000',
  votingPower: '5000000000',
  expiresEpochNo: 500,
  name: 'Test DRep',
  bio: 'A DRep for testing purposes.',
  imageUrl: 'https://example.com/avatar.png',
  links: [
    { label: 'Website', uri: 'https://example.com' },
    { label: 'Twitter', uri: 'https://twitter.com/testdrep' },
  ],
  anchorUrl: 'https://example.com/drep.json',
  anchorHash: 'a'.repeat(64),
  anchorStatus: 'fetched',
  lastSyncedAt: NOW,
  createdAt: NOW,
};

describe('upsertDrep + getDrepById', () => {
  it('inserts a row and reads it back with all fields intact', async () => {
    await upsertDrep(db(), BASE_ARGS);

    const result = await getDrepById(db(), DREP_A);

    expect(result).not.toBeNull();
    expect(result!.drepId).toBe(DREP_A);
    expect(result!.hex).toBe('abc123');
    expect(result!.hasScript).toBe(false);
    expect(result!.status).toBe('active');
    expect(result!.active).toBe(true);
    expect(result!.deposit).toBe('2000000000');
    expect(result!.votingPower).toBe('5000000000');
    expect(result!.expiresEpochNo).toBe(500);
    expect(result!.name).toBe('Test DRep');
    expect(result!.bio).toBe('A DRep for testing purposes.');
    expect(result!.imageUrl).toBe('https://example.com/avatar.png');
    expect(result!.anchorUrl).toBe('https://example.com/drep.json');
    expect(result!.anchorHash).toBe('a'.repeat(64));
    expect(result!.anchorStatus).toBe('fetched');
    expect(result!.lastSyncedAt).toBe(NOW);
    expect(result!.createdAt).toBe(NOW);
  });

  it('round-trips links as a parsed array', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: `${DREP_A}-links` });

    const result = await getDrepById(db(), `${DREP_A}-links`);
    expect(result).not.toBeNull();
    expect(result!.links).toEqual([
      { label: 'Website', uri: 'https://example.com' },
      { label: 'Twitter', uri: 'https://twitter.com/testdrep' },
    ]);
  });

  it('stores null links and reads them back as null', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: `${DREP_A}-nulllinks`, links: null });

    const result = await getDrepById(db(), `${DREP_A}-nulllinks`);
    expect(result).not.toBeNull();
    expect(result!.links).toBeNull();
  });

  it('booleans round-trip correctly (false hasScript, true active)', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: `${DREP_A}-bools`, hasScript: true, active: false });

    const result = await getDrepById(db(), `${DREP_A}-bools`);
    expect(result).not.toBeNull();
    expect(result!.hasScript).toBe(true);
    expect(typeof result!.hasScript).toBe('boolean');
    expect(result!.active).toBe(false);
    expect(typeof result!.active).toBe('boolean');
  });

  it('INSERT OR REPLACE overwrites an existing row', async () => {
    const drepId = `${DREP_A}-replace`;
    await upsertDrep(db(), { ...BASE_ARGS, drepId });

    const updated = { ...BASE_ARGS, drepId, name: 'Updated Name', votingPower: '9999', lastSyncedAt: NOW + 3600 };
    await upsertDrep(db(), updated);

    const result = await getDrepById(db(), drepId);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Updated Name');
    expect(result!.votingPower).toBe('9999');
    expect(result!.lastSyncedAt).toBe(NOW + 3600);
  });

  it('returns null for an unknown drep id', async () => {
    const result = await getDrepById(db(), 'drep1-definitely-does-not-exist-xyz');
    expect(result).toBeNull();
  });
});

describe('getDrepsByIds', () => {
  it('returns a Map with only the existing rows', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: DREP_A });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: DREP_B, name: 'DRep B', anchorHash: 'b'.repeat(64) });

    const result = await getDrepsByIds(db(), [DREP_A, DREP_B, 'drep1-not-found']);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.has(DREP_A)).toBe(true);
    expect(result.has(DREP_B)).toBe(true);
    expect(result.has('drep1-not-found')).toBe(false);
    expect(result.get(DREP_A)!.name).toBe('Test DRep');
    expect(result.get(DREP_B)!.name).toBe('DRep B');
  });

  it('returns an empty Map for empty input', async () => {
    const result = await getDrepsByIds(db(), []);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns an empty Map when no ids match', async () => {
    const result = await getDrepsByIds(db(), ['drep1-none-a', 'drep1-none-b']);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});
