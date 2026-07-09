import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertDrep, getDrepById, listDrepIdsMissingRegisteredEpoch, setRegisteredEpochs } from './dreps.js';

function drepArgs(drepId: string) {
  return {
    drepId, hex: null, hasScript: false, status: 'registered', active: true, deposit: null,
    votingPower: null, expiresEpochNo: null, name: null, bio: null, imageUrl: null,
    imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: null, links: null,
    motivations: null, qualifications: null, paymentAddress: null, doNotList: false,
    anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor', profileExtractVersion: 0, lastSyncedAt: 0, createdAt: 0,
  };
}

describe('registered_epoch read path + helpers', () => {
  it('lists missing, sets only-when-null, and surfaces it via getDrepById', async () => {
    await upsertDrep(env.DB, drepArgs('drepReg'));

    expect(await listDrepIdsMissingRegisteredEpoch(env.DB)).toContain('drepReg');
    expect((await getDrepById(env.DB, 'drepReg'))?.registeredEpoch).toBeNull();

    await setRegisteredEpochs(env.DB, [{ drepId: 'drepReg', epoch: 300 }]);
    expect((await getDrepById(env.DB, 'drepReg'))?.registeredEpoch).toBe(300);
    expect(await listDrepIdsMissingRegisteredEpoch(env.DB)).not.toContain('drepReg');

    // Idempotent: a second backfill must never overwrite a resolved value.
    await setRegisteredEpochs(env.DB, [{ drepId: 'drepReg', epoch: 999 }]);
    expect((await getDrepById(env.DB, 'drepReg'))?.registeredEpoch).toBe(300);
  });
});
