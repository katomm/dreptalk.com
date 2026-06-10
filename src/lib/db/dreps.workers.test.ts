// DReps D1 access tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises upsertDrep, getDrepById, getDrepsByIds against the
// real miniflare D1 binding with all migrations applied.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getDrepById, getDrepsByIds, listIndexableDrepIds, listDreps, upsertDrep, listDrepsForConcentration } from './dreps.js';
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
