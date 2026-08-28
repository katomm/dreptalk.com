/// <reference types="@cloudflare/workers-types" />
// On-demand pool metadata sync: resolves ticker/name/homepage for the active pools
// (SPO voters and SPO users) that are new or stale, and resolves the logo URL by
// following the CIP-6 extended-metadata chain (Koios strips it from meta_json).
// Koios meta_json is the first source, but it is null for pools whose off-chain
// document Koios never resolved, and it flickers to null between identical calls,
// so the base document we fetch for the logo anyway also serves as the identity
// fallback. The logo bytes are downloaded later by storePoolAvatars; this pass only
// records the resolved logo URL. Bounded per run; the backlog drains over crons.
import type { PoolInfoRow } from '../koios/client.js';
import { activePoolIdsNeedingSync, upsertPoolMeta } from '../db/pools.js';
import {
  type PoolIdentity,
  EMPTY_IDENTITY,
  extractExtendedUrl,
  extractLogoUrl,
  extractPoolIdentity,
  parseRecord,
  sanitizePoolIdentity,
} from './offchain.js';

// Per-run work-set size. Sized to drain a several-hundred-pool backlog over a
// handful of the frequent (20 min) cron runs while staying well under the
// Workers subrequest budget (each pool costs up to two off-chain fetches).
const DEFAULT_LIMIT = 150;
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

// One pass over a pool's off-chain documents: the base one gives the registered
// identity and the pointer to the extended one, which carries the logo.
async function resolveOffchain(
  metaUrl: string | null,
  fetchImpl: typeof fetch,
): Promise<{ identity: PoolIdentity; logoUrl: string | null }> {
  const baseText = metaUrl ? await fetchTextSafe(metaUrl, fetchImpl) : null;
  const base = baseText ? parseRecord(baseText) : null;
  return {
    identity: extractPoolIdentity(base),
    logoUrl: await resolveLogoUrl(extractExtendedUrl(base), fetchImpl),
  };
}

async function resolveLogoUrl(extendedUrl: string | null, fetchImpl: typeof fetch): Promise<string | null> {
  if (!extendedUrl) return null;
  const extendedText = await fetchTextSafe(extendedUrl, fetchImpl);
  return extendedText ? extractLogoUrl(parseRecord(extendedText)) : null;
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
    const { identity, logoUrl } = await resolveOffchain(row.meta_url ?? null, fetchImpl);
    if (logoUrl) logos++;
    // The indexer's copy comes from the same operator-written document, so it gets
    // the same normalization as the fallback before either reaches D1.
    const indexed = row.meta_json ? sanitizePoolIdentity(row.meta_json) : EMPTY_IDENTITY;
    await upsertPoolMeta(deps.db, {
      poolId: row.pool_id_bech32,
      poolHash: row.pool_id_hex ?? null,
      ticker: indexed.ticker ?? identity.ticker,
      name: indexed.name ?? identity.name,
      homepage: indexed.homepage ?? identity.homepage,
      description: indexed.description ?? identity.description,
      metaUrl: row.meta_url ?? null,
      metaHash: row.meta_hash ?? null,
      imageUrl: logoUrl,
      syncedAt: nowMs,
    });
    updated++;
  }
  return { scanned: ids.length, updated, logos };
}
