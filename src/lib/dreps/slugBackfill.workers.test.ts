// Slug backfill + slug-aware reads against the real miniflare D1 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { backfillDrepSlugs } from './sync.js';
import {
  upsertDrep, getDrepById, getDrepByIdOrSlug, listIndexableDrepIds, setDrepSlugs,
} from '../db/dreps.js';

function drepArgs(drepId: string, name: string | null) {
  return {
    drepId, hex: null, hasScript: false, status: 'registered', active: true, deposit: null,
    votingPower: null, expiresEpochNo: null, name, bio: null, imageUrl: null,
    imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: null, links: null,
    motivations: null, qualifications: null, paymentAddress: null, doNotList: false,
    anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor', profileExtractVersion: 0, lastSyncedAt: 0, createdAt: 0,
  };
}

const DREP_A = 'drep1slugaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaqqqqq';
const DREP_B = 'drep1slugbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbwwwww';
const DREP_C = 'drep1slugcccccccccccccccccccccccccccccccccccccccccccvvvvv';

describe('backfillDrepSlugs', () => {
  it('mints slugs for named DReps, leaves nameless ones alone, and is sticky', async () => {
    await upsertDrep(env.DB, drepArgs(DREP_A, 'Lisa Cardano'));
    await upsertDrep(env.DB, drepArgs(DREP_B, null));
    await upsertDrep(env.DB, drepArgs(DREP_C, '委任代表')); // no sluggable base

    const r = await backfillDrepSlugs(env.DB);
    expect(r.missing).toBe(2); // A and C are named; B has no name
    expect(r.assigned).toBe(1); // only A yields a slug

    expect((await getDrepById(env.DB, DREP_A))?.slug).toBe('lisa-cardano-qqqqq');
    expect((await getDrepById(env.DB, DREP_B))?.slug).toBeNull();
    expect((await getDrepById(env.DB, DREP_C))?.slug).toBeNull();

    // A name change never rewrites an assigned slug (sticky URLs).
    await upsertDrep(env.DB, drepArgs(DREP_A, 'Renamed DRep'));
    await backfillDrepSlugs(env.DB);
    expect((await getDrepById(env.DB, DREP_A))?.slug).toBe('lisa-cardano-qqqqq');
  });

  it('resolves a profile by id or by slug through the same lookup', async () => {
    await upsertDrep(env.DB, drepArgs(DREP_A, 'Lisa Cardano'));
    await backfillDrepSlugs(env.DB);

    const byId = await getDrepByIdOrSlug(env.DB, DREP_A);
    const bySlug = await getDrepByIdOrSlug(env.DB, 'lisa-cardano-qqqqq');
    expect(byId?.drepId).toBe(DREP_A);
    expect(bySlug?.drepId).toBe(DREP_A);
    expect(await getDrepByIdOrSlug(env.DB, 'nope-zzzzz')).toBeNull();
  });

  it('sitemap paths prefer the slug and fall back to the id', async () => {
    // Named: indexable via metadata, gets a slug. Nameless with a bio: indexable, no slug.
    await upsertDrep(env.DB, drepArgs(DREP_A, 'Lisa Cardano'));
    await upsertDrep(env.DB, { ...drepArgs(DREP_B, null), bio: 'has a bio' });
    await backfillDrepSlugs(env.DB);

    const paths = await listIndexableDrepIds(env.DB);
    expect(paths).toContain('lisa-cardano-qqqqq');
    expect(paths).toContain(DREP_B);
    expect(paths).not.toContain(DREP_A);
  });

  it('setDrepSlugs never overwrites an existing slug', async () => {
    const id = `${DREP_C}-sticky`;
    await upsertDrep(env.DB, drepArgs(id, 'Sticky'));
    await setDrepSlugs(env.DB, [{ drepId: id, slug: 'first-qqqqq' }]);
    await setDrepSlugs(env.DB, [{ drepId: id, slug: 'second-qqqqq' }]);
    expect((await getDrepById(env.DB, id))?.slug).toBe('first-qqqqq');
  });
});
