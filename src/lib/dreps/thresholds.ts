/// <reference types="@cloudflare/workers-types" />
// Live DRep voting thresholds, pulled from Koios epoch_params during the DRep
// sync and stored in app_meta so the /dreps concentration view shows current,
// not hardcoded, ratification thresholds. Reading falls back to known Conway
// mainnet constants when the value has not been synced yet.
import type { EpochParams } from '../koios/client.js';
import { getAppMeta, setAppMeta } from '../db/appMeta.js';

export const APP_META_KEY = 'drep_vote_thresholds';

// Fallback markers (fractions) used before the first threshold sync lands.
export const DEFAULT_MARKERS = [0.6, 0.67, 0.75];

export interface DrepThresholds {
  thresholds: Record<string, number>; // named dvt_* values (fractions)
  markers: number[]; // distinct sorted fractions
}

export interface StoredThresholds extends DrepThresholds {
  asOf: number;
}

const DVT_FIELDS = [
  'dvt_motion_no_confidence',
  'dvt_committee_normal',
  'dvt_committee_no_confidence',
  'dvt_update_to_constitution',
  'dvt_hard_fork_initiation',
  'dvt_p_p_network_group',
  'dvt_p_p_economic_group',
  'dvt_p_p_technical_group',
  'dvt_p_p_gov_group',
  'dvt_treasury_withdrawal',
] as const;

/** Builds the named threshold map and the distinct sorted markers from params. */
export function thresholdsFromEpochParams(params: EpochParams): DrepThresholds {
  const thresholds: Record<string, number> = {};
  for (const f of DVT_FIELDS) {
    const v = (params as Record<string, unknown>)[f];
    if (typeof v === 'number' && v > 0) thresholds[f] = v;
  }
  const markers = [...new Set(Object.values(thresholds))].sort((a, b) => a - b);
  return { thresholds, markers };
}

export interface SyncThresholdsDeps {
  koios: { epochParams(): Promise<EpochParams | null> };
  db: D1Database;
  now: number;
}

/**
 * Fetches epoch params and stores the DRep thresholds in app_meta. Returns true
 * on a successful write, false when Koios returned nothing usable. Throwing is
 * left to the caller to catch: a failure here must not abort the DRep sync.
 */
export async function syncDrepThresholds(deps: SyncThresholdsDeps): Promise<boolean> {
  const params = await deps.koios.epochParams();
  if (!params) return false;
  const built = thresholdsFromEpochParams(params);
  if (built.markers.length === 0) return false;
  await setAppMeta(deps.db, APP_META_KEY, JSON.stringify(built), deps.now);
  return true;
}

/** Reads the stored thresholds, or null if not yet synced or unparseable. */
export async function getDrepThresholds(db: D1Database): Promise<StoredThresholds | null> {
  const row = await getAppMeta(db, APP_META_KEY);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as DrepThresholds;
    if (
      typeof parsed.thresholds !== 'object' ||
      parsed.thresholds === null ||
      !Array.isArray(parsed.markers) ||
      parsed.markers.length === 0
    ) return null;
    return { thresholds: parsed.thresholds, markers: parsed.markers, asOf: row.updatedAt };
  } catch {
    return null;
  }
}
