/// <reference types="@cloudflare/workers-types" />
// Readiness of one epoch for the review: an input is available, pending (the
// sync has not produced it yet) or permanently unavailable because the series
// starts later. Only pending blocks a draft.
import { getEpochStatsByEpoch } from '../db/governanceEpochStats.js';
import type { NetworkConfig } from '../config/network.js';
import { EPOCH_STATS_SERIES_FLOOR, epochBoundsUnix } from './units.js';

export type InputState = 'available' | 'pending' | 'not_available_before_start';

export interface EpochReadiness {
  epoch: number;
  /** Stats row complete (which also certifies the epoch's votes were swept). */
  stats: InputState;
  /** Every action open during the epoch was status-synced after the epoch ended. */
  actions: InputState;
  /** Every action open during the epoch had its per-voter votes fetched after the epoch ended. */
  votes: InputState;
  staleOpenActions: number;
  unfetchedVoteActions: number;
  ready: boolean;
}

export function classifyEpoch(input: {
  epoch: number;
  statsRow: { voteDataComplete: boolean } | null;
  seriesFloor: number | null;
  staleOpenActions: number;
  unfetchedVoteActions: number;
}): EpochReadiness {
  const beforeStart = input.seriesFloor != null && input.epoch < input.seriesFloor;
  const stats: InputState = input.statsRow?.voteDataComplete ? 'available' : beforeStart ? 'not_available_before_start' : 'pending';
  const actions: InputState = input.staleOpenActions === 0 ? 'available' : 'pending';
  const votes: InputState = input.unfetchedVoteActions === 0 ? 'available' : 'pending';
  const ready = stats !== 'pending' && actions !== 'pending' && votes !== 'pending';
  return { epoch: input.epoch, stats, actions, votes, staleOpenActions: input.staleOpenActions, unfetchedVoteActions: input.unfetchedVoteActions, ready };
}

/**
 * Newest write of each sync that feeds the review, in unix milliseconds.
 * Informational only: readiness itself is decided per epoch from the rows that
 * matter for that epoch (see epochReadiness), never from the newest row of a
 * whole table, since a freshly synced unrelated action would otherwise vouch
 * for a stale one. Lives here rather than in state.ts so the window pack can
 * date itself without importing the state builder that imports the pack.
 */
export async function watermarks(db: D1Database): Promise<{ votesMs: number | null; statsMs: number | null; actionsMs: number | null }> {
  const [v, s, a] = await Promise.all([
    db.prepare('SELECT MAX(synced_at) AS t FROM drep_votes').first<{ t: number | null }>(),
    db.prepare('SELECT MAX(computed_at) AS t FROM governance_epoch_stats').first<{ t: number | null }>(),
    db.prepare('SELECT MAX(last_synced_at) AS t FROM governance_actions').first<{ t: number | null }>(),
  ]);
  return { votesMs: v?.t ?? null, statsMs: s?.t ?? null, actionsMs: a?.t ?? null };
}

/**
 * Per-epoch readiness from the relevant rows: the stats row's completeness flag
 * (set only after the epoch closed and its vote history was swept, so it is the
 * vote signal too), and every action that was open during the epoch having been
 * synced after the epoch ended (its status then reflects the boundary). Lives
 * here rather than in state.ts (which needs it) to avoid a circular import,
 * since a later task's window pack also calls this per epoch.
 */
export async function epochReadiness(db: D1Database, cfg: NetworkConfig, epoch: number): Promise<EpochReadiness> {
  const row = await getEpochStatsByEpoch(db, epoch);
  const end = epochBoundsUnix(epoch, cfg).end;
  // Actions open during the epoch must have been synced past its end twice
  // over: the status/tally sync (last_synced_at) and the per-voter vote fetch
  // (votes_synced_at). Freezing an action sets votes_synced_at back to NULL so
  // the final votes are fetched once more, and until that fetch ran the
  // per-voter data of the edition is incomplete even though the tally is fresh.
  const stale = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN last_synced_at < ? THEN 1 ELSE 0 END) AS status_stale,
         SUM(CASE WHEN votes_synced_at IS NULL OR votes_synced_at < ? THEN 1 ELSE 0 END) AS votes_stale
       FROM governance_actions
       WHERE submitted_epoch <= ? AND (COALESCE(ratified_epoch, decided_epoch) IS NULL OR COALESCE(ratified_epoch, decided_epoch) > ?)`,
    )
    .bind(end * 1000, end * 1000, epoch, epoch)
    .first<{ status_stale: number | null; votes_stale: number | null }>();
  return classifyEpoch({
    epoch,
    statsRow: row ? { voteDataComplete: row.voteDataComplete } : null,
    seriesFloor: EPOCH_STATS_SERIES_FLOOR[cfg.network],
    staleOpenActions: stale?.status_stale ?? 0,
    unfetchedVoteActions: stale?.votes_stale ?? 0,
  });
}
