/// <reference types="@cloudflare/workers-types" />
// Vote-rationale ingestion: fetch + verify + render rationales for above-threshold
// DRep votes that do not have a rendered row yet, and store them for the Positions
// tab. Bounded per run (limit) and paced, so the 20-min cron stays lean.
import { getRationaleFetchQueue, upsertActionRationale } from '../db/actionRationale.js';
import { fetchVoteRationale } from './voteRationaleAnchor.js';

// Start near 1,000,000 ADA. Calibrate against live data so it covers the bulk of
// cast voting power (DRep power is highly concentrated). Lovelace = ADA * 1e6.
export const VOTE_RATIONALE_MIN_POWER_LOVELACE = 1_000_000_000_000;

const DEFAULT_LIMIT = 40;

export interface RationaleSyncResult { fetched: number; ok: number; failed: number; }

export async function syncVoteRationales(deps: {
  db: D1Database; now: number; fetchImpl?: typeof fetch;
  minPower?: number; limit?: number; paceMs?: number;
}): Promise<RationaleSyncResult> {
  const { db, now, fetchImpl, paceMs = 0 } = deps;
  const minPower = deps.minPower ?? VOTE_RATIONALE_MIN_POWER_LOVELACE;
  const limit = deps.limit ?? DEFAULT_LIMIT;

  const jobs = await getRationaleFetchQueue(db, { minPower, limit, now });
  let ok = 0;
  let failed = 0;
  for (const [i, job] of jobs.entries()) {
    if (paceMs > 0 && i > 0) await new Promise((r) => setTimeout(r, paceMs));
    const res = await fetchVoteRationale(job.anchorUrl, job.anchorHash, { fetchImpl });
    const createdAt = job.blockTime != null ? job.blockTime * 1000 : now;
    await upsertActionRationale(db, {
      gaId: job.gaId, voterId: job.voterId,
      bodyHtml: res.status === 'ok' ? res.bodyHtml : null,
      source: 'onchain', anchorUrl: job.anchorUrl,
      status: res.status, createdAt, now,
    });
    if (res.status === 'ok') ok++; else failed++;
  }
  return { fetched: jobs.length, ok, failed };
}
