// Proactive DRep sync: enumerate every registered DRep via Koios, resolve its
// CIP-119 profile, and persist it to D1. Designed to be LEAN:
//   - Koios calls are batched (drep_list pages of 1000, drep_info chunks of 100).
//   - A DRep's off-chain anchor is re-fetched ONLY when its meta_hash changed
//     since the last sync; otherwise the stored profile is reused.
//   - D1 is written ONLY when a meaningful field actually changed.
// Idempotent and per-DRep isolated: a single DRep failing does not abort the run.
// Mirrors the shape of governance/sync.ts (injected deps, result counts).

import type { DrepInfoRow, DrepListRow, DrepUpdateRow } from '../koios/client.js';
import type { Drep } from '../db/dreps.js';
import {
  getDrepsByIds, upsertDrep, listDrepIdsMissingRegisteredEpoch, setRegisteredEpochs,
  listDrepsMissingSlug, listAssignedSlugs, setDrepSlugs,
  listActiveDrepIds, deactivateDreps,
} from '../db/dreps.js';
import { assignSlugs } from './slug.js';
import { epochFromUnix, type NetworkConfig } from '../config/network.js';
import { gcDrepMetadata } from '../db/drepMetadata.js';
import { fetchAnchorDoc, extractCip119Profile, PROFILE_EXTRACT_VERSION } from '../governance/metadata.js';
import { ingestDataUriAvatar, type ImageDownscaler } from './avatarStore.js';

// Koios paginates drep_list at 1000 rows; page through by incrementing offset.
const PAGE_SIZE = 1000;
// Chunk size for drep_info batch lookups and the matching D1 read. Bounds the
// Koios POST body, the IN-clause read, and the SQLite bound-parameter limit.
const CHUNK_SIZE = 100;
// Grace period before hosted metadata for an unregistered drep id is GC'd. It
// only needs to cover the window between hosting the CIP-119 doc and the
// registration landing on-chain (after which every sync enumerates the DRep
// before the GC runs, protecting it permanently). That window is seconds in the
// normal flow, hours at worst (slow signing, mempool), so 24h is a generous
// margin while still cleaning up abandoned/junk rows quickly.
const METADATA_GC_GRACE_SEC = 24 * 60 * 60;

export interface DrepSyncResult {
  total: number;
  updated: number;
  skipped: number;
  /** Rows transitioned to inactive because the DRep left the registered set. */
  deactivated: number;
  anchorsFetched: number;
  /** Anchor fetches pushed to the next run by maxAnchorFetches. */
  anchorsDeferred: number;
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
  /**
   * R2 bucket for inline `data:` avatars embedded in a CIP-119 doc: the sync
   * decodes and stores them here directly (no work-queue round-trip), since the
   * bytes are self-contained and the image_url column cannot hold a data URI.
   * When absent, such DReps simply keep the identicon.
   */
  bucket?: R2Bucket;
  /** Downscaler for inline avatars over the store-as-is cap; oversized fail without it. */
  downscale?: ImageDownscaler;
  /**
   * Cap on anchor fetches per run. DReps beyond the cap are written with
   * anchorStatus 'deferred' (profile preserved) and picked up by the next run,
   * because only anchorStatus 'ok' allows the no-fetch reuse path. Bounds the
   * heavy first sync, which would otherwise fetch every anchor in one
   * invocation and blow the Workers subrequest limit. Unlimited when omitted.
   */
  maxAnchorFetches?: number;
}

// The profile + anchor fields resolved for one DRep before the change check.
// A subset of Drep: exactly the fields resolveProfile owns (chain-derived fields
// like status/votingPower are filled later by buildRow).
type ResolvedProfile = Pick<
  Drep,
  'name' | 'bio' | 'imageUrl' | 'imageContentHash' | 'imageStoredUrl' | 'links' | 'motivations' | 'qualifications' | 'paymentAddress' | 'doNotList' | 'anchorUrl' | 'anchorHash' | 'anchorStatus' | 'profileExtractVersion'
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
  canFetch: boolean,
): Promise<{ profile: ResolvedProfile; fetched: boolean }> {
  const metaUrl = info.meta_url ?? null;
  const metaHash = info.meta_hash ?? null;

  if (metaUrl && metaHash) {
    // Reuse the stored profile when the hash is unchanged, the last fetch
    // succeeded, AND it was extracted at the current version. This is the key
    // cost saver: no re-fetch on an unchanged anchor. The version check makes an
    // extractor bump re-fetch every 'ok' row once (bounded by the anchor budget),
    // so a parser fix heals already-stored rows instead of leaving them frozen.
    if (
      existing &&
      metaHash === existing.anchorHash &&
      existing.anchorStatus === 'ok' &&
      existing.profileExtractVersion === PROFILE_EXTRACT_VERSION
    ) {
      return {
        profile: {
          name: existing.name,
          bio: existing.bio,
          imageUrl: existing.imageUrl,
          imageContentHash: existing.imageContentHash,
          imageStoredUrl: existing.imageStoredUrl,
          links: existing.links,
          motivations: existing.motivations,
          qualifications: existing.qualifications,
          paymentAddress: existing.paymentAddress,
          doNotList: existing.doNotList,
          anchorUrl: metaUrl,
          anchorHash: metaHash,
          anchorStatus: 'ok',
          profileExtractVersion: PROFILE_EXTRACT_VERSION,
        },
        fetched: false,
      };
    }

    // Hash changed (or first sight, or prior fetch failed): re-fetch + verify.
    // When the per-run anchor budget is spent the fetch is skipped and the
    // status recorded as 'deferred'; the non-ok handling below preserves the
    // profile, and the next run retries (only 'ok' rows take the reuse path).
    const result = canFetch
      ? await fetchAnchorDoc(metaUrl, metaHash, { fetchImpl: deps.fetchImpl })
      : { status: 'deferred' as const, doc: null };
    if (result.status === 'ok') {
      const cip119 = extractCip119Profile(result.doc);
      // Inline base64 avatar: decode and store it in R2 now, since it is
      // self-contained and the avatar-store work queue (keyed on image_url)
      // cannot carry it. A linked URL keeps the existing stored hash and is
      // handled later by the avatar-store pass. On ingest failure (or no bucket)
      // the stored hash is left untouched and the identicon shows.
      let imageContentHash = existing?.imageContentHash ?? null;
      let imageStoredUrl = existing?.imageStoredUrl ?? null;
      if (cip119.imageDataUri && deps.bucket) {
        const hash = await ingestDataUriAvatar(deps.bucket, cip119.imageDataUri, deps.downscale);
        if (hash) {
          imageContentHash = hash;
          imageStoredUrl = null; // sourced from the doc, not a URL
        }
      }
      return {
        profile: {
          name: cip119.name,
          bio: cip119.bio,
          imageUrl: cip119.imageUrl,
          imageContentHash,
          imageStoredUrl,
          links: cip119.links,
          motivations: cip119.motivations,
          qualifications: cip119.qualifications,
          paymentAddress: cip119.paymentAddress,
          doNotList: cip119.doNotList,
          anchorUrl: metaUrl,
          anchorHash: metaHash,
          anchorStatus: 'ok',
          profileExtractVersion: PROFILE_EXTRACT_VERSION,
        },
        fetched: true,
      };
    }
    // Any non-ok status (including 'deferred'): record it but PRESERVE the
    // previously resolved profile. A transient fetch failure (Koios or the host
    // being down) must not blank an otherwise-good avatar or name; the next
    // successful sync re-fetches (the stored anchorStatus is not 'ok', so the
    // reuse path is skipped). On first sight with no prior profile, the fields
    // stay null.
    return {
      profile: {
        name: existing?.name ?? null,
        bio: existing?.bio ?? null,
        imageUrl: existing?.imageUrl ?? null,
        imageContentHash: existing?.imageContentHash ?? null,
        imageStoredUrl: existing?.imageStoredUrl ?? null,
        links: existing?.links ?? null,
        motivations: existing?.motivations ?? null,
        qualifications: existing?.qualifications ?? null,
        paymentAddress: existing?.paymentAddress ?? null,
        doNotList: existing?.doNotList ?? false,
        anchorUrl: metaUrl,
        anchorHash: metaHash,
        anchorStatus: result.status,
        // Preserve the stored version (do not claim the current one): a deferred
        // or failed fetch has not re-extracted, so the next run must retry.
        profileExtractVersion: existing?.profileExtractVersion ?? 0,
      },
      fetched: canFetch,
    };
  }

  // No anchor on chain.
  return {
    profile: {
      name: null,
      bio: null,
      imageUrl: null,
      // Preserve any stored avatar (owned by the avatar-store pass) rather than
      // wiping it: matches the rest of the row's carry-over semantics.
      imageContentHash: existing?.imageContentHash ?? null,
      imageStoredUrl: existing?.imageStoredUrl ?? null,
      links: null,
      motivations: null,
      qualifications: null,
      paymentAddress: null,
      doNotList: false,
      anchorUrl: null,
      anchorHash: null,
      anchorStatus: 'no-anchor',
      // No document to extract; mark current so this row does not re-run forever.
      profileExtractVersion: PROFILE_EXTRACT_VERSION,
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
    // Owned by the voting-power-history sync, not the chain sync: carry them over
    // so a profile upsert never wipes the denormalized snapshots.
    votingPowerSnapshot: existing?.votingPowerSnapshot ?? null,
    votingPowerPrev: existing?.votingPowerPrev ?? null,
    votingPowerSnapshotEpoch: existing?.votingPowerSnapshotEpoch ?? null,
    // Delegator headcount now rides along on the same /drep_info row this sync
    // already fetches (Koios's live_delegator_count), so the chain sync owns it like
    // voting power. When Koios omits it the count is unknown: keep the stored value
    // and its timestamp, and retry next run.
    delegatorCount: info.live_delegator_count ?? existing?.delegatorCount ?? null,
    delegatorCountSyncedAt:
      info.live_delegator_count != null ? now : (existing?.delegatorCountSyncedAt ?? null),
    expiresEpochNo: info.expires_epoch_no,
    // Owned by the registration-epoch backfill, not the chain sync: carry it over
    // so a profile upsert never wipes a resolved value.
    registeredEpoch: existing?.registeredEpoch ?? null,
    name: profile.name,
    // Owned by the slug backfill, not the chain sync; sticky once assigned.
    slug: existing?.slug ?? null,
    bio: profile.bio,
    imageUrl: profile.imageUrl,
    // For a linked image these carry over the avatar-store pass's values (the
    // resolver passes them through). For an inline data: image the resolver
    // computes the hash itself, having just stored the bytes in R2.
    imageContentHash: profile.imageContentHash,
    imageStoredUrl: profile.imageStoredUrl,
    imageFetchFailedAt: existing?.imageFetchFailedAt ?? null,
    links: profile.links,
    motivations: profile.motivations,
    qualifications: profile.qualifications,
    paymentAddress: profile.paymentAddress,
    doNotList: profile.doNotList,
    anchorUrl: profile.anchorUrl,
    anchorHash: profile.anchorHash,
    anchorStatus: profile.anchorStatus,
    profileExtractVersion: profile.profileExtractVersion,
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
    next.delegatorCount !== existing.delegatorCount ||
    next.expiresEpochNo !== existing.expiresEpochNo ||
    next.name !== existing.name ||
    next.bio !== existing.bio ||
    next.imageUrl !== existing.imageUrl ||
    // An inline data: avatar ingested this run changes only this column; without
    // it a freshly stored avatar would be skipped when no other field moved.
    next.imageContentHash !== existing.imageContentHash ||
    linksKey(next.links) !== linksKey(existing.links) ||
    next.motivations !== existing.motivations ||
    next.qualifications !== existing.qualifications ||
    next.paymentAddress !== existing.paymentAddress ||
    next.doNotList !== existing.doNotList ||
    next.anchorUrl !== existing.anchorUrl ||
    next.anchorHash !== existing.anchorHash ||
    next.anchorStatus !== existing.anchorStatus ||
    // A version-only bump (fields unchanged, e.g. a row that already had a
    // string-form name) must still persist so the row stops re-fetching.
    next.profileExtractVersion !== existing.profileExtractVersion
  );
}

export async function syncDreps(deps: DrepSyncDeps): Promise<DrepSyncResult> {
  const { db, koios, now } = deps;

  const ids = await enumerateRegistered(deps);

  let updated = 0;
  let skipped = 0;
  let anchorsFetched = 0;
  let anchorsDeferred = 0;
  let failed = 0;
  const maxAnchorFetches = deps.maxAnchorFetches ?? Infinity;

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
        const canFetch = anchorsFetched < maxAnchorFetches;
        const { profile, fetched } = await resolveProfile(info, prior, deps, canFetch);
        if (fetched) anchorsFetched++;
        if (profile.anchorStatus === 'deferred') anchorsDeferred++;

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

  // Deactivate rows that still claim active voting power but are no longer in the
  // registered enumeration: the DRep deregistered (deposit returned). Koios drops
  // them from the registered set yet still answers drep_info with the deregistered
  // state, so a frozen "active" row would otherwise keep showing stale power
  // forever. Only the chain-derived columns are refreshed; the profile is kept so
  // the retired DRep stays viewable for its governance history. Guarded on a
  // non-empty enumeration so a transient empty drep_list never deactivates
  // everyone (a wrongly-deactivated row self-heals on the next sync that
  // re-enumerates it).
  let deactivated = 0;
  if (ids.length > 0) {
    const staleIds = (await listActiveDrepIds(db)).filter((id) => !registeredIds.has(id));
    if (staleIds.length > 0) {
      // drepInfoBatch sub-batches internally (DREP_INFO_MAX), so one call is fine.
      const infoById = new Map((await koios.drepInfoBatch(staleIds)).map((r) => [r.drep_id, r]));
      const rows = staleIds.flatMap((drepId) => {
        const info = infoById.get(drepId);
        // A re-registration that landed between enumeration and this lookup: leave
        // it for the next full sync, which re-enumerates and refreshes the profile.
        if (info?.active) return [];
        return [{
          drepId,
          status: info?.drep_status ?? 'deregistered',
          votingPower: info?.amount ?? '0',
          deposit: info?.deposit ?? null,
          expiresEpochNo: info?.expires_epoch_no ?? null,
          lastSyncedAt: now,
        }];
      });
      deactivated = await deactivateDreps(db, rows);
    }
  }

  // GC unreferenced junk older than the grace period. Reaching here means every
  // chunk's drepInfoBatch succeeded, so registeredIds and keepHashes are complete.
  // Guard on a non-empty enumeration: a transient empty drep_list must never be
  // treated as "no DReps exist" and wipe every hosted document.
  // `now` is milliseconds (cron passes Date.now()); created_at is stored in seconds.
  let gcScanned = 0;
  let gcDeleted = 0;
  if (ids.length > 0) {
    const gc = await gcDrepMetadata(db, {
      registeredIds,
      keepHashes,
      olderThanSec: Math.floor(now / 1000) - METADATA_GC_GRACE_SEC,
    });
    gcScanned = gc.scanned;
    gcDeleted = gc.deleted;
  }

  return { total: ids.length, updated, skipped, deactivated, anchorsFetched, anchorsDeferred, failed, gcScanned, gcDeleted };
}

export interface SlugBackfillResult {
  /** Named DReps that lacked a slug at the start of the run. */
  missing: number;
  /** Slugs assigned this run. */
  assigned: number;
}

/**
 * Mints profile slugs for named DReps that have none yet. Pure D1 work, no
 * Koios calls; steady-state cost is one indexed read returning zero rows. The
 * taken-set read only happens when there is actual work. Slugs are sticky:
 * setDrepSlugs only fills NULL, so an existing slug is never rewritten.
 */
export async function backfillDrepSlugs(db: D1Database): Promise<SlugBackfillResult> {
  const missing = await listDrepsMissingSlug(db);
  if (missing.length === 0) return { missing: 0, assigned: 0 };

  const taken = await listAssignedSlugs(db);
  const entries = assignSlugs(missing, taken);
  const assigned = await setDrepSlugs(db, entries);
  return { missing: missing.length, assigned };
}

// Koios pages /drep_updates at 1000 rows. The full unfiltered list is a handful
// of pages today; this cap bounds a single run even if the list grows.
const UPDATES_PAGE = 1000;
const MAX_UPDATE_PAGES = 12;

export interface RegisteredEpochBackfillResult {
  /** DReps that lacked a registration epoch at the start of the run. */
  missing: number;
  /** DReps whose registration epoch was written this run. */
  resolved: number;
  /** /drep_updates pages fetched this run. */
  pages: number;
}

export interface RegisteredEpochBackfillDeps {
  koios: { drepUpdates(limit: number, offset: number): Promise<DrepUpdateRow[]> };
  db: D1Database;
  cfg: NetworkConfig;
}

/**
 * Fills dreps.registered_epoch for DReps that still lack it, from the unfiltered
 * /drep_updates feed (newest first). For each missing DRep we keep the earliest
 * 'registered' block_time seen, convert it to an epoch, and batch-update.
 *
 * No-op when nothing is missing, so steady-state cost is one indexed read; the
 * one-time backfill is a few pages. Stops paging early once every missing DRep
 * has a registration row, and never exceeds MAX_UPDATE_PAGES per run.
 */
export async function backfillRegisteredEpochs(
  deps: RegisteredEpochBackfillDeps,
): Promise<RegisteredEpochBackfillResult> {
  const { koios, db, cfg } = deps;
  const missingIds = await listDrepIdsMissingRegisteredEpoch(db);
  if (missingIds.length === 0) return { missing: 0, resolved: 0, pages: 0 };

  const missing = new Set(missingIds);
  const earliest = new Map<string, number>(); // drep_id -> earliest registered block_time

  let pages = 0;
  for (let offset = 0; pages < MAX_UPDATE_PAGES; offset += UPDATES_PAGE, pages++) {
    const page = await koios.drepUpdates(UPDATES_PAGE, offset);
    for (const row of page) {
      if (row.action !== 'registered' || row.block_time == null) continue;
      if (!missing.has(row.drep_id)) continue;
      const prev = earliest.get(row.drep_id);
      if (prev == null || row.block_time < prev) earliest.set(row.drep_id, row.block_time);
    }
    if (page.length < UPDATES_PAGE) break; // last page
    // Stop early once every missing DRep has a registration row. earliest only
    // ever gains keys from the missing set, so equal sizes means all are found.
    if (earliest.size === missing.size) break;
  }

  const entries = [...earliest].map(([drepId, blockTime]) => ({
    drepId,
    epoch: epochFromUnix(blockTime, cfg),
  }));
  const resolved = await setRegisteredEpochs(db, entries);
  return { missing: missingIds.length, resolved, pages };
}
