import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { backfillRegisteredEpochs } from './sync.js';
import { upsertDrep, getDrepById } from '../db/dreps.js';
import { resolveNetwork } from '../config/network.js';

function drepArgs(drepId: string) {
  return {
    drepId, hex: null, hasScript: false, status: 'registered', active: true, deposit: null,
    votingPower: null, expiresEpochNo: null, name: null, bio: null, imageUrl: null,
    imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: null, links: null,
    motivations: null, qualifications: null, paymentAddress: null, doNotList: false,
    anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor', profileExtractVersion: 0, lastSyncedAt: 0, createdAt: 0,
  };
}

describe('backfillRegisteredEpochs', () => {
  it('resolves the earliest registered epoch per missing DRep and is a no-op once filled', async () => {
    const cfg = resolveNetwork('preprod'); // epoch 4 starts 1655769600, 5-day epochs
    const at = (epoch: number) => 1655769600 + (epoch - 4) * 5 * 24 * 60 * 60;

    await upsertDrep(env.DB, drepArgs('drepA'));
    await upsertDrep(env.DB, drepArgs('drepB'));

    const page = [
      { drep_id: 'drepA', action: 'updated', block_time: at(30) },
      { drep_id: 'drepA', action: 'registered', block_time: at(20) },
      { drep_id: 'drepA', action: 'registered', block_time: at(10) }, // earliest wins
      { drep_id: 'drepB', action: 'registered', block_time: at(15) },
    ];
    const koios = { drepUpdates: async (_l: number, off: number) => (off === 0 ? page : []) };

    const r = await backfillRegisteredEpochs({ koios, db: env.DB, cfg });
    expect(r.missing).toBe(2);
    expect(r.resolved).toBe(2);
    expect((await getDrepById(env.DB, 'drepA'))?.registeredEpoch).toBe(10);
    expect((await getDrepById(env.DB, 'drepB'))?.registeredEpoch).toBe(15);

    const r2 = await backfillRegisteredEpochs({ koios, db: env.DB, cfg });
    expect(r2).toEqual({ missing: 0, resolved: 0, pages: 0 });
  });
});
