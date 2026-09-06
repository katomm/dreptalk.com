import { EPOCH_LENGTH_SECONDS, epochStartUnix, type CardanoNetwork, type NetworkConfig } from '../config/network.js';

export const REVIEW_PACK_VERSION = 1;

/** First epoch with a governance_epoch_stats row, per network. Mainnet: the first
 *  epoch with DRep power after the Chang hard fork. Verified against the stored
 *  series on 2026-09-06. Preprod has no fixed floor yet. */
export const EPOCH_STATS_SERIES_FLOOR: Record<CardanoNetwork, number | null> = { mainnet: 508, preprod: null };

export function lovelaceToAda(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  const n = typeof s === 'number' ? s : Number(s);
  return Number.isFinite(n) ? n / 1_000_000 : null;
}

export function epochBoundsUnix(epoch: number, cfg: NetworkConfig): { start: number; end: number } {
  const start = epochStartUnix(epoch, cfg);
  return { start, end: start + EPOCH_LENGTH_SECONDS };
}
