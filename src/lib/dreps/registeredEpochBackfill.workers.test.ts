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

    const a = await getDrepById(env.DB, 'drepA');
    // Epoch from the earliest registration, registered_at from the newest one
    // (current registration period), metadata date from the newest 'updated'.
    expect(a?.registeredEpoch).toBe(10);
    expect(a?.registeredAt).toBe(at(20));
    expect(a?.metadataLastUpdatedAt).toBe(at(30));

    const b = await getDrepById(env.DB, 'drepB');
    // No 'updated' row: the metadata date falls back to the registration time.
    expect(b?.registeredEpoch).toBe(15);
    expect(b?.registeredAt).toBe(at(15));
    expect(b?.metadataLastUpdatedAt).toBe(at(15));

    const r2 = await backfillRegisteredEpochs({ koios, db: env.DB, cfg });
    expect(r2).toEqual({ missing: 0, resolved: 0, pages: 0 });
  });

  it('never overwrites already-resolved values on a re-run for a partial row', async () => {
    const cfg = resolveNetwork('preprod');
    const at = (epoch: number) => 1655769600 + (epoch - 4) * 5 * 24 * 60 * 60;

    await upsertDrep(env.DB, drepArgs('drepC'));
    // First run resolves everything from a feed with one registration.
    const koios1 = {
      drepUpdates: async (_l: number, off: number) =>
        off === 0 ? [{ drep_id: 'drepC', action: 'registered', block_time: at(12) }] : [],
    };
    await backfillRegisteredEpochs({ koios: koios1, db: env.DB, cfg });

    // Force the row back into the queue by clearing one column, then re-run with
    // a feed that would suggest different values for the other two.
    await env.DB.prepare('UPDATE dreps SET metadata_last_updated_at = NULL WHERE drep_id = ?')
      .bind('drepC')
      .run();
    const koios2 = {
      drepUpdates: async (_l: number, off: number) =>
        off === 0
          ? [
              { drep_id: 'drepC', action: 'updated', block_time: at(40) },
              { drep_id: 'drepC', action: 'registered', block_time: at(35) },
            ]
          : [],
    };
    await backfillRegisteredEpochs({ koios: koios2, db: env.DB, cfg });

    const c = await getDrepById(env.DB, 'drepC');
    expect(c?.registeredEpoch).toBe(12); // kept
    expect(c?.registeredAt).toBe(at(12)); // kept
    expect(c?.metadataLastUpdatedAt).toBe(at(40)); // filled
  });
});
