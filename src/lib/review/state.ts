/// <reference types="@cloudflare/workers-types" />
// Body of GET /api/review/state.json: where the review stands (current epoch,
// candidate window, per-epoch readiness with watermarks) plus the substance
// signals over the candidate window. Inputs to a judgement, never the judgement.
import { epochFromUnix, epochStartUnix, type NetworkConfig } from '../config/network.js';
import { epochReadiness, watermarks, type EpochReadiness } from './readiness.js';
import { EPOCH_STATS_SERIES_FLOOR, REVIEW_PACK_VERSION } from './units.js';
import { buildWindowPack } from './pack.js';
import { computeSignals, type Signals } from './signals.js';

export interface ReviewState {
  network: string;
  packVersion: number;
  currentEpoch: number;
  currentEpochStartsAt: string;
  lastCoveredEpoch: number | null;
  candidateWindow: { from: number; to: number } | null;
  closedEpochs: number[];
  readiness: { ready: boolean; epochs: Record<string, EpochReadiness>; watermarks: { votesSyncedAt: string | null; epochStatsComputedAt: string | null; actionsSyncedAt: string | null } };
  signals: Signals | null;
}

export async function buildReviewState(db: D1Database, cfg: NetworkConfig, opts: { lastCoveredEpoch: number | null; nowMs: number }): Promise<ReviewState> {
  const currentEpoch = epochFromUnix(Math.floor(opts.nowMs / 1000), cfg);
  const from = opts.lastCoveredEpoch != null ? opts.lastCoveredEpoch + 1 : (EPOCH_STATS_SERIES_FLOOR[cfg.network] ?? currentEpoch);
  const lastClosed = currentEpoch - 1;
  const to = Math.min(from + 2, lastClosed);
  const candidateWindow = to >= from ? { from, to } : null;
  const closedEpochs = candidateWindow ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : [];
  const wm = await watermarks(db);
  const epochs: Record<string, EpochReadiness> = {};
  for (const e of closedEpochs) epochs[String(e)] = await epochReadiness(db, cfg, e);
  const ready = closedEpochs.length > 0 && closedEpochs.every((e) => epochs[String(e)].ready);
  const signals = candidateWindow ? computeSignals(await buildWindowPack(db, cfg, candidateWindow.from, candidateWindow.to, { allowShort: true })) : null;
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  return {
    network: cfg.network,
    packVersion: REVIEW_PACK_VERSION,
    currentEpoch,
    currentEpochStartsAt: new Date(epochStartUnix(currentEpoch, cfg) * 1000).toISOString(),
    lastCoveredEpoch: opts.lastCoveredEpoch,
    candidateWindow,
    closedEpochs,
    readiness: { ready, epochs, watermarks: { votesSyncedAt: iso(wm.votesMs), epochStatsComputedAt: iso(wm.statsMs), actionsSyncedAt: iso(wm.actionsMs) } },
    signals,
  };
}
