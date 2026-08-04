import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertDrep, getDrepById, listDrepIdsMissingRegisteredEpoch, setRegistrationDates } from './dreps.js';

function drepArgs(drepId: string) {
  return {
    drepId, hex: null, hasScript: false, status: 'registered', active: true, deposit: null,
    votingPower: null, expiresEpochNo: null, name: null, bio: null, imageUrl: null,
    imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: null, links: null,
    motivations: null, qualifications: null, paymentAddress: null, doNotList: false,
    anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor', profileExtractVersion: 0, lastSyncedAt: 0, createdAt: 0,
  };
}

describe('registration date read path + helpers', () => {
  it('lists missing, sets only-when-null, and surfaces values via getDrepById', async () => {
    await upsertDrep(env.DB, drepArgs('drepReg'));

    expect(await listDrepIdsMissingRegisteredEpoch(env.DB)).toContain('drepReg');
    expect((await getDrepById(env.DB, 'drepReg'))?.registeredEpoch).toBeNull();

    await setRegistrationDates(env.DB, [
      { drepId: 'drepReg', epoch: 300, registeredAt: 1_700_000_000, metadataLastUpdatedAt: 1_710_000_000 },
    ]);
    const resolved = await getDrepById(env.DB, 'drepReg');
    expect(resolved?.registeredEpoch).toBe(300);
    expect(resolved?.registeredAt).toBe(1_700_000_000);
    expect(resolved?.metadataLastUpdatedAt).toBe(1_710_000_000);
    expect(await listDrepIdsMissingRegisteredEpoch(env.DB)).not.toContain('drepReg');

    // Idempotent: a second backfill must never overwrite resolved values.
    await setRegistrationDates(env.DB, [
      { drepId: 'drepReg', epoch: 999, registeredAt: 1, metadataLastUpdatedAt: 2 },
    ]);
    const after = await getDrepById(env.DB, 'drepReg');
    expect(after?.registeredEpoch).toBe(300);
    expect(after?.registeredAt).toBe(1_700_000_000);
    expect(after?.metadataLastUpdatedAt).toBe(1_710_000_000);
  });

  it('a partially filled row stays in the missing list until all three are set', async () => {
    await upsertDrep(env.DB, drepArgs('drepPartial'));
    await setRegistrationDates(env.DB, [
      { drepId: 'drepPartial', epoch: 250, registeredAt: null, metadataLastUpdatedAt: null },
    ]);
    expect(await listDrepIdsMissingRegisteredEpoch(env.DB)).toContain('drepPartial');

    await setRegistrationDates(env.DB, [
      { drepId: 'drepPartial', epoch: null, registeredAt: 1_600_000_000, metadataLastUpdatedAt: 1_600_000_000 },
    ]);
    const filled = await getDrepById(env.DB, 'drepPartial');
    expect(filled?.registeredEpoch).toBe(250);
    expect(filled?.registeredAt).toBe(1_600_000_000);
    expect(await listDrepIdsMissingRegisteredEpoch(env.DB)).not.toContain('drepPartial');
  });
});
