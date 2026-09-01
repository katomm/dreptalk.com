// Pure view models for the private DRep diagnostics page: the cohort-value
// histogram (own report-card figure against every cohort member's) and the
// own-vs-network vote-timing breakdown (per-type medians plus an
// early/middle/late split of where in the voting window each own vote landed).
import { classificationEndEpoch } from '../governance/voteTrendAssembly.js';
import { epochStartMs, type NetworkConfig } from '../config/network.js';
import type { NetworkTypeTiming, OwnVoteTiming } from '../db/recordDiagnostics.js';

export interface HistogramBucket {
  fromPct: number;
  toPct: number;
  count: number;
  isOwn: boolean;
}

export interface TypeTimingRow {
  type: string;
  ownMedianDay: number;
  networkMedianDay: number | null;
  ownVotes: number;
}

export interface TimingDetail {
  types: TypeTimingRow[];
  early: number;
  middle: number;
  late: number;
  windowBasis: number;
  skippedWindows: number;
}

const BUCKET_COUNT = 10;
const BUCKET_SIZE = 100 / BUCKET_COUNT;
const MIN_TYPE_VOTES = 3;
const DAY_MS = 86_400_000;

// v -> bucket index, the top bucket (90-100) also catches the 100 boundary.
function bucketIndex(v: number): number {
  return Math.min(BUCKET_COUNT - 1, Math.floor(v / BUCKET_SIZE));
}

/**
 * Buckets a cohort's report-card values into 10 fixed 0-100 buckets (0-10,
 * 10-20, ..., 90-100, the top one inclusive of 100), and marks which bucket
 * contains this DRep's own value. ownValue is clamped to 0..100 before
 * bucketing, so an out-of-range own figure still lands in a real bucket
 * instead of being silently dropped. ownValue null marks nothing.
 */
export function buildHistogram(values: number[], ownValue: number | null): HistogramBucket[] {
  const buckets: HistogramBucket[] = Array.from({ length: BUCKET_COUNT }, (_, i) => ({
    fromPct: i * BUCKET_SIZE,
    toPct: (i + 1) * BUCKET_SIZE,
    count: 0,
    isOwn: false,
  }));
  for (const v of values) buckets[bucketIndex(v)].count += 1;
  if (ownValue != null) {
    const clamped = Math.min(100, Math.max(0, ownValue));
    buckets[bucketIndex(clamped)].isOwn = true;
  }
  return buckets;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Own-vs-network vote timing, per action type plus an early/middle/late
 * split of where in each action's voting window the own vote landed.
 *
 * Day per vote is (blockTime * 1000 - submittedAt) / 86_400_000 (blockTime is
 * unix seconds, submittedAt is already unix milliseconds). A negative day
 * (voted before the action was even submitted, which should not happen but
 * is not guarded upstream) is dropped entirely, contributing to neither the
 * per-type medians nor the window classification.
 *
 * types: one row per action type with at least MIN_TYPE_VOTES own timed
 * votes, own median vs. the network's median for that type (null when the
 * network has no timed votes for it), sorted by ownVotes descending then
 * type ascending.
 *
 * early/middle/late: the voting window runs from submittedAt to the start of
 * classificationEndEpoch(vote) (decidedEpoch, expiryEpoch, and status, an
 * enacted action's window ends at the ratification epoch, one before its
 * decidedEpoch enactment epoch, matching the public getWindowThirds read).
 * position is how far into that window (in ms) the vote arrived, floored at
 * 0 (position < 1/3 early, <= 2/3 middle, else late). A vote whose window
 * cannot be resolved (both epochs null), is non-positive (submittedAt at or
 * past the window end), or whose position exceeds 1 (cast after the window
 * closed, so it never entered the tally) is counted in skippedWindows
 * instead of classified,
 * windowBasis is the count that did get classified (early + middle + late).
 */
export function buildTimingDetail(
  own: OwnVoteTiming[],
  network: NetworkTypeTiming[],
  cfg: NetworkConfig,
): TimingDetail {
  const networkByType = new Map(network.map((n) => [n.type, n.medianDay]));

  // Own votes with a resolvable (non-negative) day, day already computed so
  // both the per-type medians and the window pass reuse it.
  const timed = own
    .map((v) => ({ vote: v, day: (v.blockTime * 1000 - v.submittedAt) / DAY_MS }))
    .filter((t) => t.day >= 0);

  const daysByType = new Map<string, number[]>();
  for (const t of timed) {
    const list = daysByType.get(t.vote.type);
    if (list) list.push(t.day);
    else daysByType.set(t.vote.type, [t.day]);
  }
  const types: TypeTimingRow[] = [...daysByType.entries()]
    .filter(([, days]) => days.length >= MIN_TYPE_VOTES)
    .map(([type, days]) => ({
      type,
      ownMedianDay: median(days) as number,
      networkMedianDay: networkByType.get(type) ?? null,
      ownVotes: days.length,
    }))
    .sort((a, b) => b.ownVotes - a.ownVotes || a.type.localeCompare(b.type));

  let early = 0;
  let middle = 0;
  let late = 0;
  let skippedWindows = 0;
  for (const t of timed) {
    const endEpoch = classificationEndEpoch(t.vote);
    if (endEpoch == null) {
      skippedWindows += 1;
      continue;
    }
    const windowMs = epochStartMs(endEpoch, cfg) - t.vote.submittedAt;
    if (windowMs <= 0) {
      skippedWindows += 1;
      continue;
    }
    const rawPosition = (t.day * DAY_MS) / windowMs;
    if (rawPosition > 1) {
      skippedWindows += 1;
      continue;
    }
    const position = Math.max(0, rawPosition);
    if (position < 1 / 3) early += 1;
    else if (position <= 2 / 3) middle += 1;
    else late += 1;
  }

  return { types, early, middle, late, windowBasis: early + middle + late, skippedWindows };
}
