/// <reference types="@cloudflare/workers-types" />
// Phase pieces shared verbatim by more than one registry. Only truly identical
// work belongs here; kind-specific phases stay in their registry file.

import { syncPools } from '../../pools/sync.js';
import { storePoolAvatars } from '../../pools/avatarStore.js';
import type { ImageDownscaler } from '../../dreps/avatarStore.js';
import type { PhaseResult } from '../runRecorder.js';
import type { CoreSyncContext } from './context.js';
import type { SyncPhaseDef } from './registry.js';

// Resolve stake-pool metadata (ticker/name/logo) for the pools that appear on
// the platform. Runs on the frequent vote cron (not only the 6h DRep sync) so a
// large active-pool backlog drains in hours and newly-active SPO pools appear
// within one cron cycle; only-changed writes, a no-op once drained.
export const poolsPhase: SyncPhaseDef<CoreSyncContext> = {
  name: 'pools',
  run: async (ctx) => {
    const r = await syncPools({ koios: ctx.koios, db: ctx.db, fetchImpl: fetch, nowMs: Date.now() });
    console.log(`[pools] scanned=${r.scanned} updated=${r.updated} logos=${r.logos}`);
    return { items: r.updated };
  },
};

/** Mirror pool logos into R2, shared by the vote and DRep avatar phases. */
export async function mirrorPoolAvatars(
  db: D1Database,
  bucket: R2Bucket,
  downscale: ImageDownscaler | undefined,
): Promise<PhaseResult> {
  const p = await storePoolAvatars({ db, bucket, fetchImpl: fetch, downscale });
  console.log(`[pool-avatars] scanned=${p.scanned} stored=${p.stored} cleared=${p.cleared} failed=${p.failed}`);
  return { items: p.stored, failed: p.failed };
}
