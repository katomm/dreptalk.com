// Single-row storage for the network-wide vote-timing aggregates. The dreps
// cron writes one JSON row, analytics.astro and my-governance-record.astro read
// it instead of running the window-function queries on every render.
//
// The stored payload is validated with a zod schema rather than cast. A cast
// proves nothing about bytes that came back from D1, and valid JSON with a
// wrong shape (say {"drepByType": null}) would otherwise reach buildVotingTiming
// and throw there. The schema is annotated as z.ZodType<VotingTimingSnapshotPayload>
// so the compiler ties it to the interface: adding a field to NetworkTypeTiming
// fails the build here instead of silently passing validation. Same approach as
// koios/client.ts, which validates untrusted JSON from outside the type system.
//
// A missing table is deliberately NOT caught. Both migrations run before the
// merge that deploys this code, so the table always exists by then, and a catch
// here would mostly hide a forgotten migration that debug/sync reports plainly.

import { z } from 'zod';
import type { NetworkOverallTiming, NetworkTypeTiming, WindowThirds } from './recordDiagnostics.js';

export interface VotingTimingSnapshotPayload {
  drepByType: NetworkTypeTiming[];
  spoByType: NetworkTypeTiming[];
  drepOverall: NetworkOverallTiming | null;
  spoOverall: NetworkOverallTiming | null;
  /** Reduced from getHalfTurnoutDays: the median across actions and how many there were. */
  half: { medianDay: number | null; basis: number };
  thirds: WindowThirds;
}

/**
 * How old a snapshot may get before debug/sync flags it. Four consecutive
 * missed six-hourly runs, a deliberate margin over the refresh interval so a
 * single slow or skipped run is not reported as a fault. A signal only: an
 * overdue snapshot is still served, since recomputing on age would restore the
 * request-time load precisely when the cron is broken.
 */
export const SNAPSHOT_OVERDUE_MS = 24 * 60 * 60 * 1000;

/** Every counter in the payload is a non-negative whole number of votes or actions. */
const count = z.number().int().nonnegative();
const finite = z.number().finite();

const typeTiming = z.object({ type: z.string(), medianDay: finite, timedVotes: count });
const overallTiming = z.object({ medianDay: finite, timedVotes: count }).nullable();

const payloadSchema: z.ZodType<VotingTimingSnapshotPayload> = z.object({
  drepByType: z.array(typeTiming),
  spoByType: z.array(typeTiming),
  drepOverall: overallTiming,
  spoOverall: overallTiming,
  half: z.object({ medianDay: finite.nullable(), basis: count }),
  thirds: z.object({ early: count, middle: count, late: count, afterClose: count, basis: count }),
});

/**
 * One stored snapshot. `payload` is null when the row exists but its contents
 * are unusable, which keeps the metadata available for the diagnostics page
 * instead of losing the whole row to a bad payload.
 */
export interface StoredVotingTimingSnapshot {
  computedAt: number;
  epoch: number;
  payload: VotingTimingSnapshotPayload | null;
}

/**
 * Overwrites the single row. One row needs no DELETE plus INSERT: a two
 * statement variant would only be correct inside one db.batch, since D1 rolls a
 * failed batch back as a whole. Serialization happens before the write, so a
 * failure never leaves the stored row half updated.
 */
export async function writeVotingTimingSnapshot(
  db: D1Database,
  payload: VotingTimingSnapshotPayload,
  computedAt: number,
  epoch: number,
): Promise<void> {
  const json = JSON.stringify(payload);
  await db
    .prepare('INSERT OR REPLACE INTO voting_timing_snapshot (id, payload, computed_at, epoch) VALUES (1, ?, ?, ?)')
    .bind(json, computedAt, epoch)
    .run();
}

/**
 * Reads the row once. Callers that only need the numbers check `payload`, the
 * diagnostics page also uses the metadata that survives an unusable payload.
 */
export async function readVotingTimingSnapshot(db: D1Database): Promise<StoredVotingTimingSnapshot | null> {
  const row = await db
    .prepare('SELECT payload, computed_at AS computedAt, epoch FROM voting_timing_snapshot WHERE id = 1')
    .first<{ payload: string; computedAt: number; epoch: number }>();
  if (!row) return null;

  const meta = { computedAt: row.computedAt, epoch: row.epoch };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return unusable(meta, 'invalid-json');
  }
  const result = payloadSchema.safeParse(parsed);
  if (!result.success) return unusable(meta, 'invalid-shape');
  return { ...meta, payload: result.data };
}

/**
 * Logged so a permanently unusable snapshot is visible instead of silently
 * expensive. Phrased as a snapshot miss rather than "falling back to live
 * compute", because the diagnostics page also reads and computes nothing.
 */
function unusable(
  meta: { computedAt: number; epoch: number },
  reason: 'invalid-json' | 'invalid-shape',
): StoredVotingTimingSnapshot {
  console.warn(`[voting-timing-snapshot] stored snapshot unusable: ${reason}`);
  return { ...meta, payload: null };
}
