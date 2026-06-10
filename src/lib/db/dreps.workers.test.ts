// DReps D1 access tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises upsertDrep, getDrepById, getDrepsByIds against the
// real miniflare D1 binding with all migrations applied.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getDrepById, getDrepsByIds, listIndexableDrepIds, listDreps, upsertDrep, listDrepsForConcentration, listDrepsNeedingAvatar, setDrepImageStored, clearOrphanedImageStore, listReferencedImageHashes } from './dreps.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';
import { upsertVotes } from './drepVotes.js';

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
  imageContentHash: null,
  imageStoredUrl: null,
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

  it('round-trips the stored-avatar columns', async () => {
    await upsertDrep(db(), {
      ...BASE_ARGS,
      drepId: `${DREP_A}-stored`,
      imageContentHash: 'a'.repeat(64),
      imageStoredUrl: 'https://example.com/avatar.png',
    });
    const result = await getDrepById(db(), `${DREP_A}-stored`);
    expect(result!.imageContentHash).toBe('a'.repeat(64));
    expect(result!.imageStoredUrl).toBe('https://example.com/avatar.png');
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

describe('listIndexableDrepIds', () => {
  it('includes DReps with metadata and excludes thin ones', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drep1named', name: 'Named' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drep1thin', name: null, bio: null });

    const ids = await listIndexableDrepIds(db());
    expect(ids).toContain('drep1named');
    expect(ids).not.toContain('drep1thin');
  });

  it('includes a DRep that has on-chain votes but no metadata', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drep1voter', name: null, bio: null });
    await upsertVotes(db(), 'ga-x', [{ voterRole: 'DRep', voterId: 'drep1voter', voterHex: null, vote: 'Yes' }], 1);
    const ids = await listIndexableDrepIds(db());
    expect(ids).toContain('drep1voter');
  });
});

describe('listDreps', () => {
  it('sorts by voting power desc and can filter to active only', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drep1big', votingPower: '9000000000', active: true });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drep1small', votingPower: '1000000000', active: true });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drep1off', votingPower: '5000000000', active: false });

    const active = await listDreps(db(), { activeOnly: true, limit: 10, offset: 0 });
    // Only check the three rows we control: active-only must exclude drep1off.
    const activeFiltered = active.filter((d) =>
      d.drepId === 'drep1big' || d.drepId === 'drep1small' || d.drepId === 'drep1off',
    );
    expect(activeFiltered.map((d) => d.drepId)).toEqual(['drep1big', 'drep1small']);

    const all = await listDreps(db(), { activeOnly: false, limit: 10, offset: 0 });
    // Among our three rows, power order should be big (9B) > off (5B) > small (1B).
    const allFiltered = all.filter((d) =>
      d.drepId === 'drep1big' || d.drepId === 'drep1small' || d.drepId === 'drep1off',
    );
    expect(allFiltered[0].drepId).toBe('drep1big');
    expect(allFiltered[1].drepId).toBe('drep1off');
    expect(allFiltered[2].drepId).toBe('drep1small');
  });

  it('filters by name search', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drep1q', name: 'Quasar Stake' });
    const found = await listDreps(db(), { query: 'quasar', limit: 10, offset: 0 });
    expect(found.some((d) => d.drepId === 'drep1q')).toBe(true);
  });
});

describe('special DReps', () => {
  it('listDreps excludes the predefined pseudo-DReps', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drepreal', name: 'Real', votingPower: '100' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: SPECIAL_DREP_IDS[0], name: 'AbstainPseudo', votingPower: '999999999999' });

    const rows = await listDreps(db(), { activeOnly: true, limit: 50, offset: 0 });
    const ids = rows.map((r) => r.drepId);
    expect(ids).toContain('drepreal');
    expect(ids).not.toContain(SPECIAL_DREP_IDS[0]);
  });

  it('listDrepsForConcentration returns active non-special DReps ordered by power desc', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'cbig', name: 'Big', active: true, votingPower: '300' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'csmall', name: 'Small', active: true, votingPower: '100' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'cinactive', name: 'Inactive', active: false, votingPower: '500' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: SPECIAL_DREP_IDS[1], name: 'NoConfPseudo', active: true, votingPower: '999' });

    const rows = await listDrepsForConcentration(db());
    const ids = rows.map((r) => r.drepId);
    expect(ids).toEqual(['cbig', 'csmall']);
    expect(rows[0]).toEqual({ drepId: 'cbig', name: 'Big', votingPower: '300' });
  });
});

describe('avatar store queries', () => {
  it('listDrepsNeedingAvatar picks unstored and changed-source rows only', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-new', imageUrl: 'https://a.example/1.png', imageContentHash: null, imageStoredUrl: null });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-changed', imageUrl: 'https://a.example/2-new.png', imageContentHash: 'c'.repeat(64), imageStoredUrl: 'https://a.example/2-old.png' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-stored', imageUrl: 'https://a.example/3.png', imageContentHash: 'd'.repeat(64), imageStoredUrl: 'https://a.example/3.png' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-noimage', imageUrl: null, imageContentHash: null, imageStoredUrl: null });

    const rows = await listDrepsNeedingAvatar(db(), 10);
    const ids = rows.map((r) => r.drepId).sort();
    expect(ids).toEqual(['av-changed', 'av-new']);
    expect(rows.find((r) => r.drepId === 'av-new')!.imageUrl).toBe('https://a.example/1.png');
  });

  it('setDrepImageStored updates only the stored-avatar columns', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-set', imageUrl: 'https://a.example/s.png', imageContentHash: null, imageStoredUrl: null });
    await setDrepImageStored(db(), 'av-set', 'e'.repeat(64), 'https://a.example/s.png');
    const after = await getDrepById(db(), 'av-set');
    expect(after!.imageContentHash).toBe('e'.repeat(64));
    expect(after!.imageStoredUrl).toBe('https://a.example/s.png');
    expect(after!.name).toBe(BASE_ARGS.name);
  });

  it('clearOrphanedImageStore nulls the columns when the source image is gone', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-orphan', imageUrl: null, imageContentHash: 'f'.repeat(64), imageStoredUrl: 'https://a.example/gone.png' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-live', imageUrl: 'https://a.example/live.png', imageContentHash: '1'.repeat(64), imageStoredUrl: 'https://a.example/live.png' });

    const cleared = await clearOrphanedImageStore(db());
    expect(cleared).toBe(1);
    expect((await getDrepById(db(), 'av-orphan'))!.imageContentHash).toBeNull();
    expect((await getDrepById(db(), 'av-live'))!.imageContentHash).toBe('1'.repeat(64));
  });

  it('listReferencedImageHashes returns the distinct non-null hash set', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-h1', imageContentHash: '2'.repeat(64), imageStoredUrl: 'u' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-h2', imageContentHash: '2'.repeat(64), imageStoredUrl: 'u' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-h3', imageContentHash: null, imageStoredUrl: null });

    const set = await listReferencedImageHashes(db());
    expect(set.has('2'.repeat(64))).toBe(true);
    // DISTINCT dedupes the shared hash and the null row contributes nothing.
    expect(set.size).toBe(1);
  });
});
