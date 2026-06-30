/// <reference types="@cloudflare/workers-types" />
// On-demand pool metadata sync: resolves ticker/name/homepage from Koios pool_info
// for the active pools (SPO voters and SPO users) that are new or stale, and resolves
// the logo URL by following the CIP-6 extended-metadata chain (Koios strips it from
// meta_json). The logo bytes are downloaded later by storePoolAvatars; this pass only
// records the resolved logo URL. Bounded per run; the backlog drains over crons.
import type { PoolInfoRow } from '../koios/client.js';
import { activePoolIdsNeedingSync, upsertPoolMeta } from '../db/pools.js';
import { extractExtendedUrl, extractLogoUrl } from './logo.js';

const DEFAULT_LIMIT = 40;
const DEFAULT_REFRESH_MS = 14 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_META_BYTES = 256 * 1024;

export interface SyncPoolsDeps {
  koios: { poolInfoBatch(ids: string[]): Promise<PoolInfoRow[]> };
  db: D1Database;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  limit?: number;
  refreshMs?: number;
}

// Hardened JSON-text fetch: https only, timeout, size cap, never sends credentials.
async function fetchTextSafe(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: {} });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_META_BYTES) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveLogoUrl(metaUrl: string | null, fetchImpl: typeof fetch): Promise<string | null> {
  if (!metaUrl) return null;
  const baseText = await fetchTextSafe(metaUrl, fetchImpl);
  if (!baseText) return null;
  const extendedUrl = extractExtendedUrl(baseText);
  if (!extendedUrl) return null;
  const extendedText = await fetchTextSafe(extendedUrl, fetchImpl);
  if (!extendedText) return null;
  let extendedJson: unknown;
  try {
    extendedJson = JSON.parse(extendedText);
  } catch {
    return null;
  }
  return extractLogoUrl(extendedJson);
}

export async function syncPools(deps: SyncPoolsDeps): Promise<{ scanned: number; updated: number; logos: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? Date.now();
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;

  const ids = await activePoolIdsNeedingSync(deps.db, limit, nowMs - refreshMs);
  if (ids.length === 0) return { scanned: 0, updated: 0, logos: 0 };

  const rows = await deps.koios.poolInfoBatch(ids);
  let updated = 0;
  let logos = 0;
  for (const row of rows) {
    const logoUrl = await resolveLogoUrl(row.meta_url ?? null, fetchImpl);
    if (logoUrl) logos++;
    await upsertPoolMeta(deps.db, {
      poolId: row.pool_id_bech32,
      poolHash: row.pool_id_hex ?? null,
      ticker: row.meta_json?.ticker ?? null,
      name: row.meta_json?.name ?? null,
      homepage: row.meta_json?.homepage ?? null,
      description: row.meta_json?.description ?? null,
      metaUrl: row.meta_url ?? null,
      metaHash: row.meta_hash ?? null,
      imageUrl: logoUrl,
      syncedAt: nowMs,
    });
    updated++;
  }
  return { scanned: ids.length, updated, logos };
}
