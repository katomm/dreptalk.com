// Reads the six network-wide vote-timing aggregates and shapes them into the
// stored snapshot payload. Lives in analytics/ next to the other read-compute
// modules (epochStatsSync.ts does the same job for governance_epoch_stats), so
// db/ stays pure storage and there is no cycle between the two.
//
// getHalfTurnoutDays returns one day value per decided action purely so a caller
// can take its median and its length, so that reduction happens here and the raw
// array never reaches storage or a page. Everything else is a passthrough:
// MIN_TYPE_TIMED_VOTES stays in the view, so every type is stored including thin
// ones.

import type { NetworkConfig } from '../config/network.js';
import {
  getHalfTurnoutDays,
  getNetworkTimingByType,
  getNetworkTimingOverall,
  getWindowThirds,
  type NetworkOverallTiming,
  type NetworkTypeTiming,
  type WindowThirds,
} from '../db/recordDiagnostics.js';
import type { VotingTimingSnapshotPayload } from '../db/votingTimingSnapshot.js';
import { median } from './median.js';

export interface ReduceVotingTimingInput {
  drepByType: NetworkTypeTiming[];
  spoByType: NetworkTypeTiming[];
  drepOverall: NetworkOverallTiming | null;
  spoOverall: NetworkOverallTiming | null;
  halfDays: number[];
  thirds: WindowThirds;
}

/** Pure. Shapes already-read aggregate results into the stored payload. */
export function reduceVotingTimingSnapshot(input: ReduceVotingTimingInput): VotingTimingSnapshotPayload {
  return {
    drepByType: input.drepByType,
    spoByType: input.spoByType,
    drepOverall: input.drepOverall,
    spoOverall: input.spoOverall,
    half: { medianDay: median(input.halfDays), basis: input.halfDays.length },
    thirds: input.thirds,
  };
}

/**
 * Reads the six aggregates and reduces them into a storable payload. Two of the
 * four aggregate functions are called once per voter role, which is why this is
 * six reads and not four.
 *
 * These six reads are not one atomic view of the database. A concurrent sync
 * write can interleave, and no bound is claimed on how far that can move a
 * figure, since a status change can requalify every vote on an action. The
 * atomic writer guarantees only that a reader never sees a half written row.
 */
export async function loadVotingTimingSnapshot(
  db: D1Database,
  cfg: NetworkConfig,
): Promise<VotingTimingSnapshotPayload> {
  const [drepByType, spoByType, drepOverall, spoOverall, halfDays, thirds] = await Promise.all([
    getNetworkTimingByType(db, 'DRep'),
    getNetworkTimingByType(db, 'SPO'),
    getNetworkTimingOverall(db, 'DRep'),
    getNetworkTimingOverall(db, 'SPO'),
    getHalfTurnoutDays(db),
    getWindowThirds(db, cfg.epochAnchor),
  ]);
  return reduceVotingTimingSnapshot({ drepByType, spoByType, drepOverall, spoOverall, halfDays, thirds });
}
