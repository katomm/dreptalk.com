# Design: self-hosted DRep avatars (R2)

Date: 2026-06-10
Status: Approved, ready for implementation
Scope: PR 2 of 2. Follows the /dreps front end (PR 1, merged).

## Summary

DRep avatars are currently proxied on demand: `/api/avatar/<drepId>` looks up the
on-chain CIP-119 `image_url` and fetches it from the third-party host on every
cache miss. That leaks visitor request patterns to the upstream and is slow, and
`ipfs://` images are dropped entirely, so most DReps show only the identicon.

This change downloads each avatar once during the gov-sync cron, stores it in R2
content addressed by the sha256 of its bytes, and serves it from R2. Visitors
never touch a third-party host. `ipfs://` images are resolved to the gateway so
they get stored too. A paced GC pass removes orphaned objects.

## Goals

- Privacy: a visitor request for an avatar never reaches a third-party host.
- Performance: no upstream round-trip at request time; immutable edge cache.
- Coverage: ipfs-hosted avatars are stored and served, not dropped.
- Lean: download only on change, paced backfill, paced GC, all on the existing
  gov-sync cron. No new cron.

## Non goals

- No image resizing/transcoding (store the original bytes as fetched).
- No avatars for non-DRep authors (the system author keeps its initial).

## A. R2 buckets and bindings

- Buckets (created via wrangler during implementation): `dreptalk-avatars`
  (mainnet) and `dreptalk-avatars-preprod`, mirroring the per-network split of
  D1 and KV.
- Binding name `AVATARS` in both workers:
  - App worker: add `[[r2_buckets]] binding = "AVATARS" bucket_name = "dreptalk-avatars"`
    to `wrangler.toml`.
  - Cron worker: add the same binding to `workers/gov-sync/wrangler.toml`
    (mainnet) and its `[env.preprod]` section (bucket `dreptalk-avatars-preprod`).
  - Preprod app: `scripts/preprod-config.mjs` already overrides D1/KV bindings;
    add `cfg.r2_buckets = [{ binding: 'AVATARS', bucket_name: 'dreptalk-avatars-preprod' }]`.
- Type: add `AVATARS: R2Bucket` to the app env typing (`src/env.d.ts`) and the
  cron worker `Env` interface.

## B. Schema

Migration `migrations/0017_drep_image_store.sql` (next free number after
`0016_protocol_params.sql`):

```sql
-- sha256 (hex) of the avatar bytes stored in R2, content addressed at
-- avatars/<hash>. Drives the serve URL and "has a stored avatar".
ALTER TABLE dreps ADD COLUMN image_content_hash TEXT;
-- The source image_url we last successfully downloaded and stored. Lets the
-- avatar store re-download only when the source URL actually changed.
ALTER TABLE dreps ADD COLUMN image_stored_url TEXT;
```

`image_url` is unchanged (the on-chain source). The `Drep` type, `rowToDrep`,
and the existing select-based accessors gain `imageContentHash` and
`imageStoredUrl`.

## C. ipfs image resolution

In `src/lib/governance/metadata.ts`, `extractCip119Profile` currently keeps only
`http(s)` image URLs and drops `ipfs://`. Resolve `ipfs://` (both the plain
string form and the ImageObject `contentUrl` form) through the existing IPFS
gateway resolver (already used for the anchor document), so `image_url` becomes a
downloadable `https://` gateway URL. Non-resolvable schemes are still dropped.

## D. Avatar store pass

New module `src/lib/dreps/avatarStore.ts`, invoked from the cron `runDrepSync`
after `syncDreps`.

- `selectDrepsNeedingAvatar(db, limit)`: returns DReps where
  `image_url IS NOT NULL AND (image_stored_url IS NULL OR image_stored_url <> image_url)`,
  capped by `limit`. This selects exactly the initial-population rows and the
  changed-source rows, and nothing already stored and unchanged.
- For each selected DRep:
  1. Fetch `image_url` with the hardening that currently lives in the serve
     proxy, moved here so it runs once: https-only, AbortController timeout
     (8 s), content-type allowlist (png/jpeg/webp/gif/avif; svg rejected),
     content-length and hard body-size cap (256 KB).
  2. Compute `hash = hex(sha256(bytes))` via `crypto.subtle.digest`.
  3. `AVATARS.put('avatars/' + hash, bytes, { httpMetadata: { contentType } })`
     (idempotent; identical images across DReps dedupe to one object).
  4. Update the row: `image_content_hash = hash`, `image_stored_url = image_url`.
  - On any failure: leave the row unchanged so the next run retries. One bad
    avatar never aborts the pass.
- Bounded per run (small limit, paced like the existing tally/vote backfills) so
  the backlog drains over several runs and the cron stays well within limits.

`syncDreps` itself is not modified: it keeps `image_url` current, and the store
pass keys off that.

## E. GC pass (orphan cleanup)

New `gcDrepAvatars`, invoked from `runDrepSync` after the store pass, mirroring
the existing `gcDrepMetadata`:

- Read the referenced set: `SELECT DISTINCT image_content_hash FROM dreps WHERE image_content_hash IS NOT NULL`.
- List `AVATARS` objects under the `avatars/` prefix (paginated). For each object
  whose `<hash>` is not in the referenced set AND whose `uploaded` timestamp is
  older than a grace period (24 h, matching the metadata GC), delete it.
- The grace period avoids deleting an object a concurrent or just-finished store
  wrote before its DB row was read into the referenced set.
- Bounded deletions per run; returns `{ scanned, deleted }` for logging.

## F. Serve route

Rewrite `src/pages/api/avatar/[drepId].ts` to `src/pages/api/avatar/[hash].ts`:

- Validate the `hash` param is 64 lowercase hex chars; otherwise 404.
- `const obj = await env.AVATARS.get('avatars/' + hash)`; null -> 404.
- Return `obj.body` with `content-type` from `obj.httpMetadata?.contentType`
  (fallback `application/octet-stream`), `Cache-Control: public, max-age=31536000, immutable`
  (safe: the URL is content addressed), `X-Content-Type-Options: nosniff`, and a
  restrictive CSP, matching the current response hardening.
- No upstream fetch, no timeout, no size cap at request time (all handled at
  store time). The injectable `_fetchImpl` test seam is removed.

## G. Consumers

- `AuthorDescriptor` (`src/lib/forum/author.ts`): replace `hasImage?: boolean`
  with `imageHash?: string | null`.
- `AuthorIdentity.astro`: `showImage = !isSystem && !!imageHash`; the overlay uses
  `url(/api/avatar/${imageHash})`.
- Descriptor builders set `imageHash: drep?.imageContentHash ?? null` instead of
  `hasImage: !!drep?.imageUrl`. Sites: `forum/author.ts` (batch resolver),
  `pages/dreps/index.astro`, `components/ga/TopParticipantsCard.astro`,
  `components/ga/GaPositions.astro`.
- DRep profile page (`pages/dreps/[drepId].astro`): build the avatar URL and the
  JSON-LD `image` from `image_content_hash` (`/api/avatar/<hash>`) instead of
  `/api/avatar/<drepId>`; both gated on `image_content_hash` being set.

## Local development

R2 behaves exactly like the existing D1/KV bindings: with `AVATARS` in
`wrangler.toml`, `astro dev` gets a local Miniflare R2 in `.wrangler/state`, the
same persist path `npm run sync:dev` uses. Running `sync:dev` and triggering the
drep-sync cron populates it (downloading from the real upstream/gateway, which
local dev can reach). Without a local sync the bucket is empty, the serve route
404s, and the identicon shows: a graceful degradation, no dev-only upstream
fallback. Nothing to provision manually.

## Testing

- `vitest.workers.config.ts`: add `r2Buckets: ['AVATARS']` to the miniflare
  config so workers-pool tests get a real R2 binding.
- `avatarStore.workers.test.ts`: a fake fetch returns image bytes; assert the
  object lands at `avatars/<sha256>`, the row gets `image_content_hash` +
  `image_stored_url`, unchanged rows are skipped, oversize/wrong-type are
  rejected, and a fetch failure leaves the row unchanged.
- `gcDrepAvatars` test: seed referenced and orphaned objects; assert only
  orphans older than the grace period are deleted.
- Serve route: rewrite the existing `avatar.test.ts` to provide an R2 object
  (hit -> bytes + content-type + immutable cache) and assert misses and a
  malformed hash both 404.
- `metadata` test: an `ipfs://` image (string and contentUrl) resolves to the
  gateway URL; a non-http/ipfs scheme is still dropped.
- `selectDrepsNeedingAvatar` query test: picks unstored and changed-source rows,
  skips stored-and-unchanged.

## Edge cases

- No R2 binding (some envs, pre-test-config): serve route 404 -> identicon.
- Download failure / timeout / wrong type / oversize: row unchanged, retried next
  run; identicon meanwhile.
- Image removed on chain (`image_url` becomes null): `syncDreps` nulls
  `image_url`; the store pass no longer selects it; `image_content_hash` lingers
  until a later sync clears it and GC reaps the object. (A follow-up may null the
  hash when the source disappears; not required for correctness.)
- Two DReps with identical bytes: same hash, one shared R2 object.

## Out of scope

- Image resizing/transcoding or a CDN image-transform pipeline.
- Backfilling avatars for historical authors who are not DReps.
