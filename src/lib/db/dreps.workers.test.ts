// DReps D1 access tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Exercises upsertDrep, getDrepById, getDrepsByIds against the
// real miniflare D1 binding with all migrations applied.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getDrepById, getDrepsByIds, listIndexableDrepIds, listDreps, upsertDrep, deactivateDreps, effectiveDrepStatus, listDrepsForConcentration, listDrepsNeedingAvatar, setDrepImageStored, markDrepImageFetchFailed, clearOrphanedImageStore, listReferencedImageHashes } from './dreps.js';
import { createTopic } from './forum.js';
import { bindCountingDb } from './__tests__/bindCountingDb.js';
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
  imageFetchFailedAt: null,
  links: [
    { label: 'Website', uri: 'https://example.com' },
    { label: 'Twitter', uri: 'https://twitter.com/testdrep' },
  ],
  motivations: null,
  qualifications: null,
  paymentAddress: null,
  doNotList: false,
  anchorUrl: 'https://example.com/drep.json',
  anchorHash: 'a'.repeat(64),
  anchorStatus: 'fetched',
  profileExtractVersion: 0,
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
    expect(result!.imageFetchFailedAt).toBeNull();
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

  it('registration date columns round-trip and default to null', async () => {
    const drepId = `${DREP_A}-regdates`;
    await upsertDrep(db(), { ...BASE_ARGS, drepId });

    // Backfill-owned columns: written directly, not via the profile upsert.
    await db()
      .prepare('UPDATE dreps SET registered_at = ?, metadata_last_updated_at = ? WHERE drep_id = ?')
      .bind(1_678_617_600, 1_754_236_800, drepId)
      .run();

    const result = await getDrepById(db(), drepId);
    expect(result!.registeredAt).toBe(1_678_617_600);
    expect(result!.metadataLastUpdatedAt).toBe(1_754_236_800);

    await upsertDrep(db(), { ...BASE_ARGS, drepId: `${DREP_A}-regbare` });
    const bare = await getDrepById(db(), `${DREP_A}-regbare`);
    expect(bare!.registeredAt).toBeNull();
    expect(bare!.metadataLastUpdatedAt).toBeNull();
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

  it('upsert overwrites an existing row', async () => {
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

  it('stays under the D1 100-bind cap and still finds dreps beyond the first chunk', async () => {
    // Three real DReps placed at the END of a 203-id lookup, so they land past
    // the first chunk boundary. A single IN (...) would bind 203 parameters:
    // production D1 rejects that, miniflare does not, hence the bind counter.
    // The CIP-100 thread manifest is the unbounded caller.
    const real = ['drep1-bindcap-a', 'drep1-bindcap-b', 'drep1-bindcap-c'];
    for (const drepId of real) await upsertDrep(db(), { ...BASE_ARGS, drepId });
    const missing = Array.from({ length: 200 }, (_, i) => `drep1-bindcap-missing-${i}`);

    const counted = bindCountingDb(db());
    const found = await getDrepsByIds(counted.db, [...missing, ...real]);

    expect(found.size).toBe(3);
    for (const id of real) expect(found.get(id)?.drepId).toBe(id);
    expect(counted.maxBinds()).toBeLessThanOrEqual(100);
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

  it('excludes a DRep whose only post sits in a deleted topic', async () => {
    // The post survives its thread's deletion in the posts table, but it is no
    // longer reachable anywhere, so it cannot be what makes the profile worth
    // indexing. Mirrors the t.deleted = 0 gate every other read path applies.
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drep1gone', name: null, bio: null });
    await db()
      .prepare(`INSERT INTO users (id, drep_id, created_at, last_verified_at) VALUES (?, ?, 0, 0)`)
      .bind('user-gone', 'drep1gone')
      .run();
    const { topic } = await createTopic(db(), {
      categorySlug: 'general', authorId: 'user-gone', title: 'Doomed thread',
      bodyMd: 'body', bodyHtml: '<p>body</p>', now: NOW, rand: 'idx1',
    });
    await db().prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(topic.id).run();

    expect(await listIndexableDrepIds(db())).not.toContain('drep1gone');
  });

  it('includes a DRep whose post sits in a live topic', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drep1poster', name: null, bio: null });
    await db()
      .prepare(`INSERT INTO users (id, drep_id, created_at, last_verified_at) VALUES (?, ?, 0, 0)`)
      .bind('user-poster', 'drep1poster')
      .run();
    await createTopic(db(), {
      categorySlug: 'general', authorId: 'user-poster', title: 'Live thread',
      bodyMd: 'body', bodyHtml: '<p>body</p>', now: NOW, rand: 'idx2',
    });

    expect(await listIndexableDrepIds(db())).toContain('drep1poster');
  });

  it('excludes a DRep that has on-chain votes but no metadata (thin, vote-only)', async () => {
    // A recorded vote alone no longer qualifies: a nameless vote-only profile is
    // thin and kept out of the sitemap. Mirrors isIndexableProfile.
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drep1voter', name: null, bio: null });
    await upsertVotes(db(), 'ga-x', [{ voterRole: 'DRep', voterId: 'drep1voter', voterHex: null, vote: 'Yes' }], 1);
    const ids = await listIndexableDrepIds(db());
    expect(ids).not.toContain('drep1voter');
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

});

describe('listDreps sort', () => {
  async function seedFull(drepId: string, power: string, count: number | null): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO dreps (drep_id, status, active, voting_power, delegator_count,
                          last_synced_at, created_at)
       VALUES (?, 'registered', 1, ?, ?, 0, 0)`,
    )
      .bind(drepId, power, count)
      .run();
  }

  it('sorts by delegator count desc when sort=delegators', async () => {
    await seedFull('drep_p_big', '9000', 1);   // most power, fewest delegators
    await seedFull('drep_p_mid', '5000', 50);
    await seedFull('drep_p_low', '1000', 200);  // least power, most delegators

    const byPower = (await listDreps(env.DB, { sort: 'power', limit: 10 })).map((d) => d.drepId);
    expect(byPower.slice(0, 3)).toEqual(['drep_p_big', 'drep_p_mid', 'drep_p_low']);

    const byDelegators = (await listDreps(env.DB, { sort: 'delegators', limit: 10 })).map((d) => d.drepId);
    expect(byDelegators.slice(0, 3)).toEqual(['drep_p_low', 'drep_p_mid', 'drep_p_big']);
  });

  it('sorts a NULL delegator count last under sort=delegators', async () => {
    await seedFull('drep_null_a', '7000', 30);
    await seedFull('drep_null_b', '3000', 10);
    await seedFull('drep_null_c', '1000', null); // never counted -> must sort last

    const byDelegators = (await listDreps(env.DB, { sort: 'delegators', limit: 10 })).map((d) => d.drepId);
    const filtered = byDelegators.filter((id) =>
      id === 'drep_null_a' || id === 'drep_null_b' || id === 'drep_null_c',
    );
    expect(filtered).toEqual(['drep_null_a', 'drep_null_b', 'drep_null_c']);
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
    expect(rows[0]).toEqual({ drepId: 'cbig', name: 'Big', slug: null, votingPower: '300' });
  });
});

describe('avatar store queries', () => {
  it('listDrepsNeedingAvatar picks unstored and changed-source rows only', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-new', imageUrl: 'https://a.example/1.png', imageContentHash: null, imageStoredUrl: null });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-changed', imageUrl: 'https://a.example/2-new.png', imageContentHash: 'c'.repeat(64), imageStoredUrl: 'https://a.example/2-old.png' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-stored', imageUrl: 'https://a.example/3.png', imageContentHash: 'd'.repeat(64), imageStoredUrl: 'https://a.example/3.png' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-noimage', imageUrl: null, imageContentHash: null, imageStoredUrl: null });

    const rows = await listDrepsNeedingAvatar(db(), 10, 100);
    const ids = rows.map((r) => r.drepId).sort();
    expect(ids).toEqual(['av-changed', 'av-new']);
    expect(rows.find((r) => r.drepId === 'av-new')!.imageUrl).toBe('https://a.example/1.png');
  });

  it('listDrepsNeedingAvatar puts never-failed rows first, then failures oldest first', async () => {
    // By drep_id alone 'av-ord-a' would win every run; the failure stamps must
    // rotate it behind the never-attempted row and the older failure.
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-ord-a', imageUrl: 'https://a.example/a.png', imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: 2000 });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-ord-b', imageUrl: 'https://a.example/b.png', imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: 1000 });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-ord-c', imageUrl: 'https://a.example/c.png', imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: null });

    const rows = await listDrepsNeedingAvatar(db(), 10, 100);
    expect(rows.map((r) => r.drepId)).toEqual(['av-ord-c', 'av-ord-b', 'av-ord-a']);
  });

  it('markDrepImageFetchFailed stamps only the given rows', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-f1', imageFetchFailedAt: null });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-f2', imageFetchFailedAt: null });

    await markDrepImageFetchFailed(db(), ['av-f1'], 5000);
    expect((await getDrepById(db(), 'av-f1'))!.imageFetchFailedAt).toBe(5000);
    expect((await getDrepById(db(), 'av-f2'))!.imageFetchFailedAt).toBeNull();
  });

  it('markDrepImageFetchFailed is a no-op for an empty id list', async () => {
    await expect(markDrepImageFetchFailed(db(), [], 5000)).resolves.toBeUndefined();
  });

  it('setDrepImageStored updates only the stored-avatar columns', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-set', imageUrl: 'https://a.example/s.png', imageContentHash: null, imageStoredUrl: null });
    await setDrepImageStored(db(), 'av-set', 'e'.repeat(64), 'https://a.example/s.png');
    const after = await getDrepById(db(), 'av-set');
    expect(after!.imageContentHash).toBe('e'.repeat(64));
    expect(after!.imageStoredUrl).toBe('https://a.example/s.png');
    expect(after!.name).toBe(BASE_ARGS.name);
  });

  it('setDrepImageStored clears the failure stamp on success', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-heal', imageUrl: 'https://a.example/h.png', imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: 7000 });
    await setDrepImageStored(db(), 'av-heal', 'e'.repeat(64), 'https://a.example/h.png');
    expect((await getDrepById(db(), 'av-heal'))!.imageFetchFailedAt).toBeNull();
  });

  it('clearOrphanedImageStore nulls the columns when the source image is gone', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-orphan', imageUrl: null, imageContentHash: 'f'.repeat(64), imageStoredUrl: 'https://a.example/gone.png' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-live', imageUrl: 'https://a.example/live.png', imageContentHash: '1'.repeat(64), imageStoredUrl: 'https://a.example/live.png' });

    const cleared = await clearOrphanedImageStore(db());
    expect(cleared).toBe(1);
    expect((await getDrepById(db(), 'av-orphan'))!.imageContentHash).toBeNull();
    expect((await getDrepById(db(), 'av-live'))!.imageContentHash).toBe('1'.repeat(64));
  });

  it('clearOrphanedImageStore keeps inline data: avatars (no image_url, no stored_url)', async () => {
    // A data: URI avatar is ingested with image_url null and image_stored_url
    // null (it is sourced from the doc, not a fetched URL). It must NOT be
    // treated as an orphan, or the avatar pass would wipe it every run.
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-datauri', imageUrl: null, imageContentHash: 'a'.repeat(64), imageStoredUrl: null });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-orphan2', imageUrl: null, imageContentHash: 'b'.repeat(64), imageStoredUrl: 'https://a.example/gone.png' });

    const cleared = await clearOrphanedImageStore(db());
    expect(cleared).toBe(1);
    expect((await getDrepById(db(), 'av-datauri'))!.imageContentHash).toBe('a'.repeat(64));
    expect((await getDrepById(db(), 'av-orphan2'))!.imageContentHash).toBeNull();
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

describe('delegator status-change fan-out jobs', () => {
  // upsertDrep/deactivateDreps take lastSyncedAt in unix milliseconds; the job's
  // source_time / created_at are seconds (Math.floor(lastSyncedAt / 1000)).
  const T_MS = 1_700_000_000_000;
  const T_SEC = 1_700_000_000;

  async function jobsFor(subjectId: string) {
    return (
      await env.DB
        .prepare('SELECT * FROM notification_fanout_jobs WHERE subject_id = ? ORDER BY source_time, event_key')
        .bind(subjectId)
        .all<{ event_key: string; event_type: string; subject_id: string; source_time: number; payload: string; created_at: number; updated_at: number }>()
    ).results;
  }

  // Proxies a D1Database so the status fan-out job INSERT is swapped for a
  // statement that fails at execution (an unknown table). The failure is intrinsic
  // to the job statement, so it aborts whichever batch the production function
  // places the job in. With the correct single-batch composition that is the same
  // batch as the status write, so both roll back. Everything else forwards to the
  // real DB. If a regression split the status write and the job into two separate
  // db.batch/.run() calls, the status write would commit before the job failed and
  // the "status unchanged" assertions below would fail.
  function poisonJobInsert(db: D1Database): D1Database {
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) =>
            sql.includes('INTO notification_fanout_jobs')
              ? // 7 placeholders, matching buildJobInsert's bind arity, so bind
                // succeeds and the failure surfaces at batch execution, not at bind.
                target.prepare('INSERT INTO __no_such_fanout_table__ (a, b, c, d, e, f, g) VALUES (?, ?, ?, ?, ?, ?, ?)')
              : target.prepare(sql);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('effectiveDrepStatus maps the active boolean to the two effective states', () => {
    expect(effectiveDrepStatus(true)).toBe('active');
    expect(effectiveDrepStatus(false)).toBe('inactive');
  });

  it('(a) upsertDrep on a followed active DRep going inactive emits an active->inactive job', async () => {
    const drepId = 'drep-status-a';
    // Seed the baseline active row without opts, so creation emits no job.
    await upsertDrep(db(), { ...BASE_ARGS, drepId, active: true, status: 'active' });
    await upsertDrep(
      db(),
      { ...BASE_ARGS, drepId, active: false, status: 'inactive', lastSyncedAt: T_MS },
      { followedDrepIds: new Set([drepId]) },
    );

    const jobs = await jobsFor(drepId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].event_key).toBe(`drep-status:${drepId}:active:inactive:${T_SEC}`);
    expect(jobs[0].event_type).toBe('delegator_drep_status_changed');
    expect(jobs[0].subject_id).toBe(drepId);
    expect(jobs[0].source_time).toBe(T_SEC);
    expect(jobs[0].created_at).toBe(T_SEC);
    expect(jobs[0].updated_at).toBe(T_SEC);
    expect(JSON.parse(jobs[0].payload)).toEqual({
      sourceTime: T_SEC,
      drepId,
      from: { effective: 'active', status: 'active' },
      to: { effective: 'inactive', status: 'inactive' },
    });
    // The status write landed too.
    expect((await getDrepById(db(), drepId))!.active).toBe(false);
  });

  it('(b) upsertDrep reactivation (inactive->active) emits a job (both directions fire)', async () => {
    const drepId = 'drep-status-b';
    await upsertDrep(db(), { ...BASE_ARGS, drepId, active: false, status: 'inactive' });
    await upsertDrep(
      db(),
      { ...BASE_ARGS, drepId, active: true, status: 'active', lastSyncedAt: T_MS },
      { followedDrepIds: new Set([drepId]) },
    );

    const jobs = await jobsFor(drepId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].event_key).toBe(`drep-status:${drepId}:inactive:active:${T_SEC}`);
    expect(JSON.parse(jobs[0].payload)).toMatchObject({
      from: { effective: 'inactive', status: 'inactive' },
      to: { effective: 'active', status: 'active' },
    });
  });

  it('(c) upsertDrep with an unchanged effective status emits NO job', async () => {
    const drepId = 'drep-status-c';
    await upsertDrep(db(), { ...BASE_ARGS, drepId, active: true, status: 'active' });
    // Raw status shifts within the same effective state, voting power moves; still active.
    await upsertDrep(
      db(),
      { ...BASE_ARGS, drepId, active: true, status: 'registered', votingPower: '42', lastSyncedAt: T_MS },
      { followedDrepIds: new Set([drepId]) },
    );
    expect(await jobsFor(drepId)).toHaveLength(0);
  });

  it('(d) deactivateDreps on a followed active DRep emits a job in the same batch as the UPDATE', async () => {
    const drepId = 'drep-status-d';
    await upsertDrep(db(), { ...BASE_ARGS, drepId, active: true, status: 'active' });
    const n = await deactivateDreps(
      db(),
      [{ drepId, status: 'deregistered', votingPower: '0', deposit: null, expiresEpochNo: null, lastSyncedAt: T_MS }],
      { followedDrepIds: new Set([drepId]) },
    );
    expect(n).toBe(1);

    const jobs = await jobsFor(drepId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].event_key).toBe(`drep-status:${drepId}:active:inactive:${T_SEC}`);
    expect(JSON.parse(jobs[0].payload)).toEqual({
      sourceTime: T_SEC,
      drepId,
      from: { effective: 'active', status: 'active' },
      to: { effective: 'inactive', status: 'deregistered' },
    });
    // The deactivation UPDATE landed in the same batch.
    expect((await getDrepById(db(), drepId))!.active).toBe(false);
  });

  it('(e) a non-followed DRep emits NO job (both paths)', async () => {
    const drepId = 'drep-status-e';
    await upsertDrep(db(), { ...BASE_ARGS, drepId, active: true, status: 'active' });
    await upsertDrep(
      db(),
      { ...BASE_ARGS, drepId, active: false, status: 'inactive', lastSyncedAt: T_MS },
      { followedDrepIds: new Set(['some-other-drep']) },
    );
    await deactivateDreps(
      db(),
      [{ drepId, status: 'deregistered', votingPower: '0', deposit: null, expiresEpochNo: null, lastSyncedAt: T_MS }],
      { followedDrepIds: new Set(['some-other-drep']) },
    );
    expect(await jobsFor(drepId)).toHaveLength(0);
  });

  it('(f) first creation of a followed DRep (no old row) emits NO job', async () => {
    const drepId = 'drep-status-f';
    await upsertDrep(
      db(),
      { ...BASE_ARGS, drepId, active: true, status: 'active', lastSyncedAt: T_MS },
      { followedDrepIds: new Set([drepId]) },
    );
    expect(await jobsFor(drepId)).toHaveLength(0);
    // deactivateDreps on a never-seen followed id likewise emits nothing (no prior row).
    await deactivateDreps(
      db(),
      [{ drepId: 'drep-status-f-ghost', status: 'deregistered', votingPower: '0', deposit: null, expiresEpochNo: null, lastSyncedAt: T_MS }],
      { followedDrepIds: new Set(['drep-status-f-ghost']) },
    );
    expect(await jobsFor('drep-status-f-ghost')).toHaveLength(0);
  });

  it('(g) two opposite transitions the same day at different seconds emit two distinct jobs', async () => {
    const drepId = 'drep-status-g';
    await upsertDrep(db(), { ...BASE_ARGS, drepId, active: true, status: 'active' });
    // active -> inactive at T.
    await upsertDrep(
      db(),
      { ...BASE_ARGS, drepId, active: false, status: 'inactive', lastSyncedAt: T_MS },
      { followedDrepIds: new Set([drepId]) },
    );
    // inactive -> active at T + 5000ms (still the same day, distinct second).
    await upsertDrep(
      db(),
      { ...BASE_ARGS, drepId, active: true, status: 'active', lastSyncedAt: T_MS + 5000 },
      { followedDrepIds: new Set([drepId]) },
    );

    const jobs = await jobsFor(drepId);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.event_key)).toEqual([
      `drep-status:${drepId}:active:inactive:${T_SEC}`,
      `drep-status:${drepId}:inactive:active:${T_SEC + 5}`,
    ]);
  });

  it('(atomicity) upsertDrep folds the status write and its job into one batch: a job failure rolls back the status write too', async () => {
    const drepId = 'drep-status-atom-upsert';
    await upsertDrep(db(), { ...BASE_ARGS, drepId, active: true, status: 'active' });

    await expect(
      upsertDrep(
        poisonJobInsert(env.DB),
        { ...BASE_ARGS, drepId, active: false, status: 'inactive', lastSyncedAt: T_MS },
        { followedDrepIds: new Set([drepId]) },
      ),
    ).rejects.toThrow();

    // The status write must have rolled back with the failed job: still active.
    expect((await getDrepById(db(), drepId))!.active).toBe(true);
    expect(await jobsFor(drepId)).toHaveLength(0);
  });

  it('(atomicity) deactivateDreps folds the UPDATE and its job into one batch: a job failure rolls back the UPDATE too', async () => {
    const drepId = 'drep-status-atom-deact';
    await upsertDrep(db(), { ...BASE_ARGS, drepId, active: true, status: 'active' });

    await expect(
      deactivateDreps(
        poisonJobInsert(env.DB),
        [{ drepId, status: 'deregistered', votingPower: '0', deposit: null, expiresEpochNo: null, lastSyncedAt: T_MS }],
        { followedDrepIds: new Set([drepId]) },
      ),
    ).rejects.toThrow();

    expect((await getDrepById(db(), drepId))!.active).toBe(true);
    expect(await jobsFor(drepId)).toHaveLength(0);
  });
});

describe('upsertDrep rowid stability', () => {
  it('keeps the rowid and FTS entry across re-syncs, and only name/bio changes rewrite the index', async () => {
    await upsertDrep(db(), BASE_ARGS);
    const before = await db().prepare('SELECT rowid FROM dreps WHERE drep_id = ?').bind(DREP_A).first<{ rowid: number }>();

    // Voting-power-only change: row identity and index untouched.
    await upsertDrep(db(), { ...BASE_ARGS, votingPower: '6000000000' });
    const after = await db().prepare('SELECT rowid FROM dreps WHERE drep_id = ?').bind(DREP_A).first<{ rowid: number }>();
    expect(after!.rowid).toBe(before!.rowid);

    // Still findable under the original name.
    const hits = await db()
      .prepare('SELECT rowid FROM dreps_fts WHERE dreps_fts MATCH ?')
      .bind('"test" "drep"')
      .all();
    expect(hits.results).toHaveLength(1);

    // A name change updates the index.
    await upsertDrep(db(), { ...BASE_ARGS, name: 'Renamed Drep' });
    const renamed = await db()
      .prepare('SELECT rowid FROM dreps_fts WHERE dreps_fts MATCH ?')
      .bind('"renamed"')
      .all();
    expect(renamed.results).toHaveLength(1);
    const oldName = await db()
      .prepare('SELECT rowid FROM dreps_fts WHERE dreps_fts MATCH ?')
      .bind('"test" "drep"')
      .all();
    expect(oldName.results).toHaveLength(0);
  });
});
