// Proactive DRep sync: enumerate every registered DRep via Koios, resolve its
// CIP-119 profile, and persist it to D1. Designed to be LEAN:
//   - Koios calls are batched (drep_list pages of 1000, drep_info chunks of 100).
//   - A DRep's off-chain anchor is re-fetched ONLY when its meta_hash changed
//     since the last sync; otherwise the stored profile is reused.
//   - D1 is written ONLY when a meaningful field actually changed.
// Idempotent and per-DRep isolated: a single DRep failing does not abort the run.
// Mirrors the shape of governance/sync.ts (injected deps, result counts).

import type { DrepInfoRow, DrepListRow } from '../koios/client.js';
import type { Drep } from '../db/dreps.js';
import { getDrepsByIds, upsertDrep } from '../db/dreps.js';
import { gcDrepMetadata } from '../db/drepMetadata.js';
import { fetchAnchorDoc, extractCip119Profile } from '../governance/metadata.js';

// Koios paginates drep_list at 1000 rows; page through by incrementing offset.
const PAGE_SIZE = 1000;
// Chunk size for drep_info batch lookups and the matching D1 read. Bounds the
// Koios POST body, the IN-clause read, and the SQLite bound-parameter limit.
const CHUNK_SIZE = 100;
// Grace period before hosted metadata for an unregistered drep id is GC'd. Long
// enough that a DRep can host its CIP-119 doc and then submit its registration tx.
const METADATA_GC_GRACE_SEC = 14 * 24 * 60 * 60;

export interface DrepSyncResult {
  total: number;
  updated: number;
  skipped: number;
  anchorsFetched: number;
  failed: number;
  // Hosted-metadata GC (junk written for self-generated keys).
  gcScanned: number;
  gcDeleted: number;
}

export interface DrepSyncDeps {
  koios: {
    drepList(limit: number, offset: number): Promise<DrepListRow[]>;
    drepInfoBatch(ids: string[]): Promise<DrepInfoRow[]>;
  };
  db: D1Database;
  now: number;
  /** Anchor fetch implementation (injected for tests). */
  fetchImpl?: typeof fetch;
}

// The profile + anchor fields resolved for one DRep before the change check.
// A subset of Drep: exactly the fields resolveProfile owns (chain-derived fields
// like status/votingPower are filled later by buildRow).
type ResolvedProfile = Pick<
  Drep,
  'name' | 'bio' | 'imageUrl' | 'links' | 'anchorUrl' | 'anchorHash' | 'anchorStatus'
>;

/** Splits an array into fixed-size chunks. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Stable JSON for comparing the links array regardless of reference identity. */
function linksKey(links: { label: string; uri: string }[] | null): string {
  return links == null ? '' : JSON.stringify(links);
}

/**
 * Enumerates every registered DRep id, paging drep_list until a short/empty
 * page signals the end. Only DReps with registered === true are collected.
 */
async function enumerateRegistered(deps: DrepSyncDeps): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await deps.koios.drepList(PAGE_SIZE, offset);
    for (const row of page) {
      if (row.registered) ids.push(row.drep_id);
    }
    // A page shorter than the requested size is the last page.
    if (page.length < PAGE_SIZE) break;
  }
  return ids;
}

/**
 * Resolves the profile + anchor fields for one DRep.
 *
 * The cost saver: when the on-chain meta_hash equals the stored anchorHash AND
 * the stored row's anchor was previously fetched OK, the stored profile is
 * reused and NO network fetch happens. `fetched` reports whether the anchor was
 * fetched so the caller can tally anchorsFetched.
 */
async function resolveProfile(
  info: DrepInfoRow,
  existing: Drep | undefined,
  deps: DrepSyncDeps,
): Promise<{ profile: ResolvedProfile; fetched: boolean }> {
  const metaUrl = info.meta_url ?? null;
  const metaHash = info.meta_hash ?? null;

  if (metaUrl && metaHash) {
    // Reuse the stored profile when the hash is unchanged and the last fetch
    // succeeded. This is the key cost saver: no re-fetch on an unchanged anchor.
    if (existing && metaHash === existing.anchorHash && existing.anchorStatus === 'ok') {
      return {
        profile: {
          name: existing.name,
          bio: existing.bio,
          imageUrl: existing.imageUrl,
          links: existing.links,
          anchorUrl: metaUrl,
          anchorHash: metaHash,
          anchorStatus: 'ok',
        },
        fetched: false,
      };
    }

    // Hash changed (or first sight, or prior fetch failed): re-fetch + verify.
    const result = await fetchAnchorDoc(metaUrl, metaHash, { fetchImpl: deps.fetchImpl });
    if (result.status === 'ok') {
      const cip119 = extractCip119Profile(result.doc);
      return {
        profile: {
          name: cip119.name,
          bio: cip119.bio,
          imageUrl: cip119.imageUrl,
          links: cip119.links,
          anchorUrl: metaUrl,
          anchorHash: metaHash,
          anchorStatus: 'ok',
        },
        fetched: true,
      };
    }
    // Any non-ok status: record the error status but PRESERVE the previously
    // resolved profile. A transient fetch failure (Koios or the host being down)
    // must not blank an otherwise-good avatar or name; the next successful sync
    // re-fetches (the stored anchorStatus is not 'ok', so the reuse path is
    // skipped). On first sight with no prior profile, the fields stay null.
    return {
      profile: {
        name: existing?.name ?? null,
        bio: existing?.bio ?? null,
        imageUrl: existing?.imageUrl ?? null,
        links: existing?.links ?? null,
        anchorUrl: metaUrl,
        anchorHash: metaHash,
        anchorStatus: result.status,
      },
      fetched: true,
    };
  }

  // No anchor on chain.
  return {
    profile: {
      name: null,
      bio: null,
      imageUrl: null,
      links: null,
      anchorUrl: null,
      anchorHash: null,
      anchorStatus: 'no-anchor',
    },
    fetched: false,
  };
}

/** Builds the full DRep row to persist from chain info + resolved profile. */
function buildRow(info: DrepInfoRow, profile: ResolvedProfile, existing: Drep | undefined, now: number): Drep {
  return {
    drepId: info.drep_id,
    hex: info.hex,
    hasScript: info.has_script,
    status: info.drep_status,
    active: info.active,
    deposit: info.deposit,
    votingPower: info.amount,
    expiresEpochNo: info.expires_epoch_no,
    name: profile.name,
    bio: profile.bio,
    imageUrl: profile.imageUrl,
    links: profile.links,
    anchorUrl: profile.anchorUrl,
    anchorHash: profile.anchorHash,
    anchorStatus: profile.anchorStatus,
    lastSyncedAt: now,
    // Preserve the original creation time on update; set it on first insert.
    createdAt: existing?.createdAt ?? now,
  };
}

/**
 * Returns true when the new row differs from the existing row on a meaningful
 * field, or when there is no existing row. lastSyncedAt and createdAt are NOT
 * compared: a sync-time bump alone must never trigger a write.
 */
function hasChanged(next: Drep, existing: Drep | undefined): boolean {
  if (!existing) return true;
  return (
    next.status !== existing.status ||
    next.active !== existing.active ||
    next.deposit !== existing.deposit ||
    next.votingPower !== existing.votingPower ||
    next.expiresEpochNo !== existing.expiresEpochNo ||
    next.name !== existing.name ||
    next.bio !== existing.bio ||
    next.imageUrl !== existing.imageUrl ||
    linksKey(next.links) !== linksKey(existing.links) ||
    next.anchorUrl !== existing.anchorUrl ||
    next.anchorHash !== existing.anchorHash ||
    next.anchorStatus !== existing.anchorStatus
  );
}

export async function syncDreps(deps: DrepSyncDeps): Promise<DrepSyncResult> {
  const { db, koios, now } = deps;

  const ids = await enumerateRegistered(deps);

  let updated = 0;
  let skipped = 0;
  let anchorsFetched = 0;
  let failed = 0;

  // Collected for the hosted-metadata GC: every registered drep id and every
  // current on-chain anchor hash. A row survives GC if it matches either, so a
  // real DRep's metadata is never deleted.
  const registeredIds = new Set(ids);
  const keepHashes = new Set<string>();

  for (const chunkIds of chunk(ids, CHUNK_SIZE)) {
    // One batched Koios lookup and one batched D1 read per chunk (no N+1). The
    // two are independent (outbound HTTP vs local D1), so run them together.
    const [infoRows, existing] = await Promise.all([
      koios.drepInfoBatch(chunkIds),
      getDrepsByIds(db, chunkIds),
    ]);

    for (const info of infoRows) {
      if (info.meta_hash) keepHashes.add(info.meta_hash.toLowerCase());
      try {
        const prior = existing.get(info.drep_id);
        const { profile, fetched } = await resolveProfile(info, prior, deps);
        if (fetched) anchorsFetched++;

        const row = buildRow(info, profile, prior, now);

        if (hasChanged(row, prior)) {
          await upsertDrep(db, row);
          updated++;
        } else {
          // Nothing meaningful changed: skip the write entirely.
          skipped++;
        }
      } catch {
        // Isolate per-DRep failures so one bad row cannot abort the run.
        failed++;
      }
    }
  }

  // Reaching here means every chunk's drepInfoBatch succeeded, so registeredIds
  // and keepHashes are complete; GC unreferenced junk older than the grace period.
  // `now` is milliseconds (cron passes Date.now()); created_at is stored in seconds.
  const { scanned: gcScanned, deleted: gcDeleted } = await gcDrepMetadata(db, {
    registeredIds,
    keepHashes,
    olderThanSec: Math.floor(now / 1000) - METADATA_GC_GRACE_SEC,
  });

  return { total: ids.length, updated, skipped, anchorsFetched, failed, gcScanned, gcDeleted };
}
