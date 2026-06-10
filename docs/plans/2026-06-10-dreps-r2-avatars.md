# Self-hosted DRep avatars (R2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download each DRep avatar once during the gov-sync cron, store it in R2 content addressed by sha256, and serve it from R2 so visitors never touch a third-party host; resolve ipfs:// images; GC orphaned objects.

**Architecture:** The drep-sync cron gains an avatar store pass (select rows needing work, fetch with the hardening that today lives in the serve proxy, sha256, R2 put, row update) and a paced GC pass. The serve route becomes a thin R2 read at `/api/avatar/<hash>` with an immutable cache. Consumers switch from `hasImage` + drepId-URL to an `imageHash` + hash-URL. SQL stays in `src/lib/db/dreps.ts`; orchestration in `src/lib/dreps/avatarStore.ts`; the serve core in `src/lib/dreps/avatarServe.ts`.

**Tech Stack:** Cloudflare Workers + R2 + D1, Astro 6 SSR, Vitest (workers pool with a real Miniflare R2 binding).

---

## File structure

Created:
- `migrations/0017_drep_image_store.sql`
- `src/lib/dreps/avatarStore.ts` + `src/lib/dreps/avatarStore.workers.test.ts`
- `src/lib/dreps/avatarServe.ts` + `src/lib/dreps/avatarServe.workers.test.ts`
- `src/pages/api/avatar/[hash].ts`

Modified:
- `wrangler.toml`, `workers/gov-sync/wrangler.toml`, `scripts/preprod-config.mjs`, `src/env.d.ts`, `vitest.workers.config.ts` (R2 binding everywhere)
- `src/lib/db/dreps.ts` + `src/lib/db/dreps.workers.test.ts` (2 new columns, 4 avatar queries)
- `src/lib/dreps/sync.ts` + `src/lib/dreps/sync.workers.test.ts` (buildRow preserves the stored-image columns)
- `src/lib/governance/metadata.ts` + `src/lib/governance/cip119.test.ts` (ipfs image resolution)
- `workers/gov-sync/src/index.ts` (cron wiring)
- `src/lib/forum/author.ts`, `src/components/AuthorIdentity.astro`, `src/pages/dreps/index.astro`, `src/pages/dreps/[drepId].astro`, `src/components/ga/TopParticipantsCard.astro`, `src/components/ga/GaPositions.astro` (imageHash consumers)

Deleted:
- `src/pages/api/avatar/[drepId].ts`, `src/pages/api/avatar/avatar.test.ts` (replaced by the hash route + workers tests)

---

## Task 1: R2 buckets, bindings, types, test config

**Files:**
- Modify: `wrangler.toml` (after the `[[d1_databases]]` block)
- Modify: `workers/gov-sync/wrangler.toml` (top level and `[env.preprod]`)
- Modify: `scripts/preprod-config.mjs` (after the `cfg.kv_namespaces` assignment)
- Modify: `src/env.d.ts` (Cloudflare.Env)
- Modify: `vitest.workers.config.ts` (miniflare block)

- [ ] **Step 1: Create the buckets**

Run:
```bash
npx wrangler r2 bucket create dreptalk-avatars
npx wrangler r2 bucket create dreptalk-avatars-preprod
```
Expected: both report `Created bucket`. If a bucket already exists, that error is fine; continue.

- [ ] **Step 2: App worker binding**

In `wrangler.toml`, after the `[[d1_databases]]` block (before the SESSIONS KV block), add:

```toml
# R2 bucket holding self-hosted DRep avatars, written by the gov-sync avatar
# store pass and served by /api/avatar/<hash>. Content addressed by sha256.
[[r2_buckets]]
binding = "AVATARS"
bucket_name = "dreptalk-avatars"
```

- [ ] **Step 3: Cron worker bindings (mainnet + preprod)**

In `workers/gov-sync/wrangler.toml`, after the top-level `[[d1_databases]]` block, add:

```toml
# R2 bucket for self-hosted DRep avatars; written by the drep-sync avatar pass.
[[r2_buckets]]
binding = "AVATARS"
bucket_name = "dreptalk-avatars"
```

And in the preprod section, after the `[[env.preprod.d1_databases]]` block, add:

```toml
[[env.preprod.r2_buckets]]
binding = "AVATARS"
bucket_name = "dreptalk-avatars-preprod"
```

- [ ] **Step 4: Preprod app config derivation**

In `scripts/preprod-config.mjs`, after the `cfg.kv_namespaces = [...]` assignment, add:

```js
cfg.r2_buckets = [{ binding: 'AVATARS', bucket_name: 'dreptalk-avatars-preprod' }];
```

- [ ] **Step 5: Type the binding**

In `src/env.d.ts`, inside `Cloudflare.Env`, after the `RATE_LIMITER` line, add:

```ts
    AVATARS?: R2Bucket;
```

- [ ] **Step 6: Test config**

In `vitest.workers.config.ts`, inside the `miniflare` object, after the `kvNamespaces` line, add:

```ts
          r2Buckets: ['AVATARS'],
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; the full suite still passes (the new binding is additive).

- [ ] **Step 8: Commit**

```bash
git add wrangler.toml workers/gov-sync/wrangler.toml scripts/preprod-config.mjs src/env.d.ts vitest.workers.config.ts
git commit -m "feat: add AVATARS R2 bucket bindings for self-hosted DRep avatars"
```

---

## Task 2: Migration 0017 and Drep column plumbing

**Files:**
- Create: `migrations/0017_drep_image_store.sql`
- Modify: `src/lib/db/dreps.ts` (Drep interface, DrepRow, rowToDrep, upsertDrep)
- Test: `src/lib/db/dreps.workers.test.ts`

- [ ] **Step 1: Write the migration**

Create `migrations/0017_drep_image_store.sql`:

```sql
-- Self-hosted avatar store columns.
-- image_content_hash: sha256 (hex) of the avatar bytes stored in R2 at
--   avatars/<hash>; drives the serve URL and "has a stored avatar".
-- image_stored_url: the source image_url we last successfully downloaded, so
--   the avatar store re-downloads only when the on-chain source URL changed.
ALTER TABLE dreps ADD COLUMN image_content_hash TEXT;
ALTER TABLE dreps ADD COLUMN image_stored_url TEXT;
```

- [ ] **Step 2: Write the failing test**

In `src/lib/db/dreps.workers.test.ts`, add the two new fields to `BASE_ARGS` (after `imageUrl`):

```ts
  imageContentHash: null,
  imageStoredUrl: null,
```

And add this test inside the existing `describe('upsertDrep + getDrepById', ...)` block:

```ts
  it('round-trips the stored-avatar columns', async () => {
    await upsertDrep(db(), {
      ...BASE_ARGS,
      drepId: `${DREP_A}-stored`,
      imageContentHash: 'a'.repeat(64),
      imageStoredUrl: 'https://example.com/avatar.png',
    });
    const result = await getDrepById(db(), `${DREP_A}-stored`);
    expect(result!.imageContentHash).toBe('a'.repeat(64));
    expect(result!.imageStoredUrl).toBe('https://example.com/avatar.png');
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/dreps.workers.test.ts`
Expected: FAIL (TypeScript: `imageContentHash` does not exist on the upsert args type; or unknown column before the code change).

- [ ] **Step 4: Plumb the columns through the db layer**

In `src/lib/db/dreps.ts`:

In the `Drep` interface, after `imageUrl: string | null;`, add:

```ts
  /** sha256 (hex) of the stored avatar bytes in R2 (avatars/<hash>), or null when not stored. */
  imageContentHash: string | null;
  /** The source image_url last successfully downloaded into R2. */
  imageStoredUrl: string | null;
```

In the `DrepRow` interface, after `image_url: string | null;`, add:

```ts
  image_content_hash: string | null;
  image_stored_url: string | null;
```

In `rowToDrep`, after `imageUrl: row.image_url,`, add:

```ts
    imageContentHash: row.image_content_hash,
    imageStoredUrl: row.image_stored_url,
```

In `upsertDrep`: add to the args type, after `imageUrl: string | null;`:

```ts
    imageContentHash: string | null;
    imageStoredUrl: string | null;
```

In the INSERT statement, change the column list and placeholders to include the new columns (after `image_url`):

```ts
      `INSERT OR REPLACE INTO dreps
         (drep_id, hex, has_script, status, active, deposit, voting_power,
          expires_epoch_no, name, bio, image_url, image_content_hash,
          image_stored_url, links, anchor_url, anchor_hash, anchor_status,
          last_synced_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
```

And in `.bind(...)`, after `args.imageUrl,` add:

```ts
      args.imageContentHash,
      args.imageStoredUrl,
```

- [ ] **Step 5: Fix remaining compile errors in callers**

`src/lib/dreps/sync.ts` `buildRow` now fails to compile (missing fields). Add, after `imageUrl: profile.imageUrl,`:

```ts
    // The stored-avatar columns are owned by the avatar store pass, not by the
    // chain sync: carry them over so an INSERT OR REPLACE never wipes them.
    imageContentHash: existing?.imageContentHash ?? null,
    imageStoredUrl: existing?.imageStoredUrl ?? null,
```

(`hasChanged` needs no change: both sides always carry the same existing values, so they never differ.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/dreps.workers.test.ts src/lib/dreps/sync.workers.test.ts`
Expected: PASS (all existing tests plus the new round-trip).

- [ ] **Step 7: Commit**

```bash
git add migrations/0017_drep_image_store.sql src/lib/db/dreps.ts src/lib/db/dreps.workers.test.ts src/lib/dreps/sync.ts
git commit -m "feat: add stored-avatar columns to dreps"
```

---

## Task 3: Sync preserves stored-avatar columns (regression test)

**Files:**
- Test: `src/lib/dreps/sync.workers.test.ts`

Task 2 added the carry-over in `buildRow`; this task pins it with a test so a future refactor cannot silently wipe stored avatars on every profile re-sync.

- [ ] **Step 1: Write the test**

Add at the end of `src/lib/dreps/sync.workers.test.ts` (it already imports `syncDreps`, `upsertDrep`, `getDrepById`, and the `DrepListRow`/`DrepInfoRow` types):

```ts
describe('stored-avatar preservation', () => {
  it('a re-sync write preserves image_content_hash and image_stored_url', async () => {
    const drepId = 'drep1avatarkeep';
    const anchorHash = 'f'.repeat(64);
    // Seed: a synced row with a stored avatar and an ok anchor.
    await upsertDrep(env.DB, {
      drepId,
      hex: 'cafe01',
      hasScript: false,
      status: 'registered',
      active: true,
      deposit: '500000000',
      votingPower: '1000',
      expiresEpochNo: 600,
      name: 'Avatar Keeper',
      bio: null,
      imageUrl: 'https://example.com/keep.png',
      imageContentHash: 'b'.repeat(64),
      imageStoredUrl: 'https://example.com/keep.png',
      links: null,
      anchorUrl: 'https://example.com/keep.json',
      anchorHash,
      anchorStatus: 'ok',
      lastSyncedAt: 1,
      createdAt: 1,
    });

    // Fake koios: same DRep, unchanged anchor (reuse path, no fetch), but a
    // changed voting power so hasChanged forces a write.
    const listRow: DrepListRow = { drep_id: drepId, hex: 'cafe01', has_script: false, registered: true };
    const infoRow: DrepInfoRow = {
      drep_id: drepId,
      hex: 'cafe01',
      has_script: false,
      drep_status: 'registered',
      deposit: '500000000',
      active: true,
      expires_epoch_no: 600,
      amount: '2000',
      meta_url: 'https://example.com/keep.json',
      meta_hash: anchorHash,
    };
    const koios = {
      drepList: async () => [listRow],
      drepInfoBatch: async () => [infoRow],
    };

    const result = await syncDreps({ koios, db: env.DB, now: 2_000 });
    expect(result.updated).toBe(1);

    const after = await getDrepById(env.DB, drepId);
    expect(after!.votingPower).toBe('2000');
    expect(after!.imageContentHash).toBe('b'.repeat(64));
    expect(after!.imageStoredUrl).toBe('https://example.com/keep.png');
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/dreps/sync.workers.test.ts`
Expected: PASS (the carry-over is already implemented; this is a pinning test. If it FAILS, buildRow is wrong; fix it before proceeding).

- [ ] **Step 3: Commit**

```bash
git add src/lib/dreps/sync.workers.test.ts
git commit -m "test: pin stored-avatar column preservation across re-syncs"
```

---

## Task 4: Avatar work-queue and GC queries in the db layer

**Files:**
- Modify: `src/lib/db/dreps.ts` (4 new functions at the end)
- Test: `src/lib/db/dreps.workers.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the imports in `src/lib/db/dreps.workers.test.ts`:

```ts
import {
  listDrepsNeedingAvatar,
  setDrepImageStored,
  clearOrphanedImageStore,
  listReferencedImageHashes,
} from './dreps.js';
```

Add at the end of the file:

```ts
describe('avatar store queries', () => {
  it('listDrepsNeedingAvatar picks unstored and changed-source rows only', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-new', imageUrl: 'https://a.example/1.png', imageContentHash: null, imageStoredUrl: null });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-changed', imageUrl: 'https://a.example/2-new.png', imageContentHash: 'c'.repeat(64), imageStoredUrl: 'https://a.example/2-old.png' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-stored', imageUrl: 'https://a.example/3.png', imageContentHash: 'd'.repeat(64), imageStoredUrl: 'https://a.example/3.png' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-noimage', imageUrl: null, imageContentHash: null, imageStoredUrl: null });

    const rows = await listDrepsNeedingAvatar(db(), 10);
    const ids = rows.map((r) => r.drepId).sort();
    expect(ids).toEqual(['av-changed', 'av-new']);
    expect(rows.find((r) => r.drepId === 'av-new')!.imageUrl).toBe('https://a.example/1.png');
  });

  it('setDrepImageStored updates only the stored-avatar columns', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-set', imageUrl: 'https://a.example/s.png', imageContentHash: null, imageStoredUrl: null });
    await setDrepImageStored(db(), 'av-set', 'e'.repeat(64), 'https://a.example/s.png');
    const after = await getDrepById(db(), 'av-set');
    expect(after!.imageContentHash).toBe('e'.repeat(64));
    expect(after!.imageStoredUrl).toBe('https://a.example/s.png');
    expect(after!.name).toBe(BASE_ARGS.name);
  });

  it('clearOrphanedImageStore nulls the columns when the source image is gone', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-orphan', imageUrl: null, imageContentHash: 'f'.repeat(64), imageStoredUrl: 'https://a.example/gone.png' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-live', imageUrl: 'https://a.example/live.png', imageContentHash: '1'.repeat(64), imageStoredUrl: 'https://a.example/live.png' });

    const cleared = await clearOrphanedImageStore(db());
    expect(cleared).toBe(1);
    expect((await getDrepById(db(), 'av-orphan'))!.imageContentHash).toBeNull();
    expect((await getDrepById(db(), 'av-live'))!.imageContentHash).toBe('1'.repeat(64));
  });

  it('listReferencedImageHashes returns the distinct non-null hash set', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-h1', imageContentHash: '2'.repeat(64), imageStoredUrl: 'u' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-h2', imageContentHash: '2'.repeat(64), imageStoredUrl: 'u' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'av-h3', imageContentHash: null, imageStoredUrl: null });

    const set = await listReferencedImageHashes(db());
    expect(set.has('2'.repeat(64))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/dreps.workers.test.ts`
Expected: FAIL (the four functions are not exported).

- [ ] **Step 3: Implement the queries**

Add at the end of `src/lib/db/dreps.ts`:

```ts
export interface DrepAvatarSourceRow {
  drepId: string;
  imageUrl: string;
}

/**
 * Work queue for the avatar store pass: DReps whose source image exists but is
 * not yet stored, or whose source URL changed since it was stored. Ordered by
 * drep_id for deterministic paging; capped by limit.
 */
export async function listDrepsNeedingAvatar(db: D1Database, limit: number): Promise<DrepAvatarSourceRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT drep_id, image_url FROM dreps
         WHERE image_url IS NOT NULL
           AND (image_stored_url IS NULL OR image_stored_url <> image_url)
         ORDER BY drep_id
         LIMIT ?`,
      )
      .bind(limit)
      .all<{ drep_id: string; image_url: string }>()
  ).results ?? [];
  return rows.map((r) => ({ drepId: r.drep_id, imageUrl: r.image_url }));
}

/** Records a successful store: the R2 content hash and the source URL it came from. */
export async function setDrepImageStored(
  db: D1Database,
  drepId: string,
  contentHash: string,
  storedUrl: string,
): Promise<void> {
  await db
    .prepare('UPDATE dreps SET image_content_hash = ?, image_stored_url = ? WHERE drep_id = ?')
    .bind(contentHash, storedUrl, drepId)
    .run();
}

/**
 * Clears the stored-avatar columns for rows whose on-chain image disappeared,
 * so the GC can reap the now-unreferenced R2 object. Returns rows cleared.
 */
export async function clearOrphanedImageStore(db: D1Database): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE dreps SET image_content_hash = NULL, image_stored_url = NULL
       WHERE image_url IS NULL AND image_content_hash IS NOT NULL`,
    )
    .run();
  return res.meta.changes ?? 0;
}

/** The set of content hashes still referenced by a dreps row (GC keep set). */
export async function listReferencedImageHashes(db: D1Database): Promise<Set<string>> {
  const rows = (
    await db
      .prepare('SELECT DISTINCT image_content_hash AS h FROM dreps WHERE image_content_hash IS NOT NULL')
      .all<{ h: string }>()
  ).results ?? [];
  return new Set(rows.map((r) => r.h));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/dreps.workers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/dreps.ts src/lib/db/dreps.workers.test.ts
git commit -m "feat: add avatar work-queue and GC queries"
```

---

## Task 5: Resolve ipfs:// profile images to the gateway

**Files:**
- Modify: `src/lib/governance/metadata.ts` (extractCip119Profile image handling)
- Test: `src/lib/governance/cip119.test.ts`

- [ ] **Step 1: Update the tests (one flips, one is new)**

In `src/lib/governance/cip119.test.ts`, replace the existing test `'drops an ipfs: image URL (not an http(s) URL)'` with:

```ts
  it('resolves an ipfs: image URL to the public gateway', () => {
    const doc = { body: { image: 'ipfs://QmSomeHash' } };
    const profile = extractCip119Profile(doc);
    expect(profile.imageUrl).toBe('https://ipfs.io/ipfs/QmSomeHash');
  });

  it('resolves an ipfs: contentUrl in an ImageObject to the gateway', () => {
    const doc = { body: { image: { contentUrl: 'ipfs://QmOtherHash/avatar.png' } } };
    const profile = extractCip119Profile(doc);
    expect(profile.imageUrl).toBe('https://ipfs.io/ipfs/QmOtherHash/avatar.png');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.config.ts src/lib/governance/cip119.test.ts`
Expected: FAIL (imageUrl is null for ipfs inputs).

- [ ] **Step 3: Implement the resolution**

In `src/lib/governance/metadata.ts`:

Update the doc comment on `resolveAnchorUrl` to reflect its second caller:

```ts
/**
 * Resolves an on-chain URL (anchor document or profile image) to a fetchable
 * URL: http(s) passes through, ipfs://<cid>/<path> maps to the public gateway,
 * anything else is unsupported (null).
 */
function resolveAnchorUrl(raw: string): string | null {
```

In `extractCip119Profile`, replace the image extraction block:

```ts
  // imageUrl: body.image may be a plain string URL or a CIP-119 ImageObject with
  // contentUrl. http(s) is kept, ipfs:// resolves to the gateway, anything else
  // (data:, javascript:, ...) is dropped. http:// survives extraction but the
  // avatar store is https-only, so it is never fetched or stored.
  let imageUrl: string | null = null;
  const imgField = body.image;
  const rawImageUrl =
    typeof imgField === 'string'
      ? imgField
      : imgField && typeof imgField === 'object' && typeof asRecord(imgField).contentUrl === 'string'
        ? (asRecord(imgField).contentUrl as string)
        : '';
  if (rawImageUrl) {
    const resolved = resolveAnchorUrl(rawImageUrl);
    if (resolved) imageUrl = resolved.slice(0, MAX_PROFILE_IMAGE_URL_LEN);
  }
```

(The `isHttpUrl` helper keeps its other callers; do not remove it.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts src/lib/governance/cip119.test.ts`
Expected: PASS, including the existing http(s)/javascript:/data: cases. Note: the existing http(s) cases must still pass byte-identical URLs; `resolveAnchorUrl` returns `url.href`, which normalizes. The fixture URLs in this file (`https://example.com/avatar.png` etc.) are already normalized, so they round-trip unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/governance/metadata.ts src/lib/governance/cip119.test.ts
git commit -m "feat: resolve ipfs profile images to the gateway"
```

---

## Task 6: Avatar store pass

**Files:**
- Create: `src/lib/dreps/avatarStore.ts`
- Test: `src/lib/dreps/avatarStore.workers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/dreps/avatarStore.workers.test.ts`:

```ts
// Avatar store tests; run in workerd with the real miniflare R2 binding
// (AVATARS) and D1. The image fetch is injected.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { storeDrepAvatars, AVATAR_KEY_PREFIX } from './avatarStore.js';
import { upsertDrep, getDrepById } from '../db/dreps.js';
import { bytesToHex } from '../crypto/hex.js';

const db = () => env.DB;
const bucket = () => env.AVATARS as R2Bucket;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

async function sha256Of(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function imageResponse(bytes: Uint8Array, contentType = 'image/png'): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

const BASE = {
  hex: 'ab01',
  hasScript: false,
  status: 'registered',
  active: true,
  deposit: null,
  votingPower: null,
  expiresEpochNo: null,
  name: null,
  bio: null,
  links: null,
  anchorUrl: null,
  anchorHash: null,
  anchorStatus: 'no-anchor',
  lastSyncedAt: 1,
  createdAt: 1,
  imageContentHash: null,
  imageStoredUrl: null,
};

describe('storeDrepAvatars', () => {
  it('downloads, stores at avatars/<sha256>, and stamps the row', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-ok', imageUrl: 'https://img.example/ok.png' });
    const fetchImpl = (async () => imageResponse(PNG_BYTES)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.stored).toBe(1);

    const hash = await sha256Of(PNG_BYTES);
    const obj = await bucket().get(AVATAR_KEY_PREFIX + hash);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata?.contentType).toBe('image/png');

    const row = await getDrepById(db(), 'st-ok');
    expect(row!.imageContentHash).toBe(hash);
    expect(row!.imageStoredUrl).toBe('https://img.example/ok.png');
  });

  it('skips rows already stored with an unchanged source', async () => {
    await upsertDrep(db(), {
      ...BASE,
      drepId: 'st-skip',
      imageUrl: 'https://img.example/same.png',
      imageContentHash: 'a'.repeat(64),
      imageStoredUrl: 'https://img.example/same.png',
    });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return imageResponse(PNG_BYTES);
    }) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(calls).toBe(0);
    expect(r.scanned).toBe(0);
  });

  it('rejects a non-https source without fetching', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-http', imageUrl: 'http://img.example/insecure.png' });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return imageResponse(PNG_BYTES);
    }) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(calls).toBe(0);
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-http'))!.imageContentHash).toBeNull();
  });

  it('rejects a disallowed content type and leaves the row unchanged', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-svg', imageUrl: 'https://img.example/evil.svg' });
    const fetchImpl = (async () => imageResponse(PNG_BYTES, 'image/svg+xml')) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-svg'))!.imageContentHash).toBeNull();
  });

  it('rejects an oversize body', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-big', imageUrl: 'https://img.example/big.png' });
    const big = new Uint8Array(256 * 1024 + 1);
    const fetchImpl = (async () => imageResponse(big)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-big'))!.imageContentHash).toBeNull();
  });

  it('a fetch failure leaves the row unchanged for the next run', async () => {
    await upsertDrep(db(), { ...BASE, drepId: 'st-err', imageUrl: 'https://img.example/down.png' });
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.failed).toBe(1);
    expect((await getDrepById(db(), 'st-err'))!.imageStoredUrl).toBeNull();
  });

  it('clears the stored columns when the source image disappeared', async () => {
    await upsertDrep(db(), {
      ...BASE,
      drepId: 'st-gone',
      imageUrl: null,
      imageContentHash: 'b'.repeat(64),
      imageStoredUrl: 'https://img.example/was.png',
    });
    const fetchImpl = (async () => imageResponse(PNG_BYTES)) as unknown as typeof fetch;

    const r = await storeDrepAvatars({ db: db(), bucket: bucket(), fetchImpl });
    expect(r.cleared).toBe(1);
    expect((await getDrepById(db(), 'st-gone'))!.imageContentHash).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/dreps/avatarStore.workers.test.ts`
Expected: FAIL (cannot resolve `./avatarStore.js`).

- [ ] **Step 3: Write the module**

Create `src/lib/dreps/avatarStore.ts`:

```ts
/// <reference types="@cloudflare/workers-types" />
// Avatar store pass: downloads each DRep's CIP-119 image once and stores it in
// R2, content addressed by the sha256 of its bytes. Runs on the drep-sync cron.
// The download hardening that used to run per request in the serve proxy
// (https-only, timeout, type allowlist, size cap) runs here, once per image.
// Failures leave the row unchanged so the next run retries; one bad avatar
// never aborts the pass.
import { bytesToHex } from '../crypto/hex.js';
import {
  listDrepsNeedingAvatar,
  setDrepImageStored,
  clearOrphanedImageStore,
} from '../db/dreps.js';

// Maximum accepted image size (256 KB): larger is mislinked or hostile.
const MAX_IMAGE_BYTES = 256 * 1024;
// Upstream fetch timeout in milliseconds.
const FETCH_TIMEOUT_MS = 8_000;
// Raster types only. SVG is rejected: it can carry scripts.
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
// R2 key prefix; the full key is avatars/<sha256-hex>.
export const AVATAR_KEY_PREFIX = 'avatars/';

export interface AvatarStoreDeps {
  db: D1Database;
  bucket: R2Bucket;
  /** Image fetch implementation (injected for tests). */
  fetchImpl?: typeof fetch;
  /** Max downloads per run; the backlog drains over successive cron runs. */
  limit?: number;
}

export interface AvatarStoreResult {
  scanned: number;
  stored: number;
  cleared: number;
  failed: number;
}

/** sha256 of the given bytes as lowercase hex. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/**
 * Downloads and validates one image. Returns null on any rejection: non-https,
 * fetch error/timeout, non-2xx, disallowed type, oversize, or empty body.
 */
async function fetchValidatedImage(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    // Explicitly empty headers: never send cookies or auth to the image host.
    res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: {} });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(contentType)) return null;

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;

  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;

  return { bytes, contentType };
}

export async function storeDrepAvatars(deps: AvatarStoreDeps): Promise<AvatarStoreResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const limit = deps.limit ?? 25;

  // First null out rows whose on-chain image disappeared, so their objects
  // become unreferenced and the GC can reap them.
  const cleared = await clearOrphanedImageStore(deps.db);

  const rows = await listDrepsNeedingAvatar(deps.db, limit);
  let stored = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const img = await fetchValidatedImage(row.imageUrl, fetchImpl);
      if (!img) {
        failed++;
        continue;
      }
      const hash = await sha256Hex(img.bytes);
      // Idempotent: identical bytes across DReps share one object.
      await deps.bucket.put(AVATAR_KEY_PREFIX + hash, img.bytes, {
        httpMetadata: { contentType: img.contentType },
      });
      await setDrepImageStored(deps.db, row.drepId, hash, row.imageUrl);
      stored++;
    } catch {
      // Isolate per-DRep failures; the row stays unchanged and retries next run.
      failed++;
    }
  }

  return { scanned: rows.length, stored, cleared, failed };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/dreps/avatarStore.workers.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dreps/avatarStore.ts src/lib/dreps/avatarStore.workers.test.ts
git commit -m "feat: add R2 avatar store pass"
```

---

## Task 7: GC pass for orphaned avatar objects

**Files:**
- Modify: `src/lib/dreps/avatarStore.ts` (append gcDrepAvatars)
- Test: `src/lib/dreps/avatarStore.workers.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/dreps/avatarStore.workers.test.ts` (add `gcDrepAvatars` to the existing import from `./avatarStore.js`, and `upsertDrep` is already imported):

```ts
describe('gcDrepAvatars', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('deletes orphaned objects past the grace period, keeps referenced ones', async () => {
    const keepHash = '3'.repeat(64);
    await upsertDrep(db(), { ...BASE, drepId: 'gc-ref', imageUrl: 'https://img.example/r.png', imageContentHash: keepHash, imageStoredUrl: 'https://img.example/r.png' });
    await bucket().put(AVATAR_KEY_PREFIX + keepHash, PNG_BYTES);
    await bucket().put(AVATAR_KEY_PREFIX + '4'.repeat(64), PNG_BYTES);

    // Both objects were uploaded "now"; evaluating 25h in the future puts the
    // orphan past the 24h grace period.
    const r = await gcDrepAvatars({ db: db(), bucket: bucket(), nowMs: Date.now() + 25 * 60 * 60 * 1000 });
    expect(r.deleted).toBe(1);
    expect(await bucket().get(AVATAR_KEY_PREFIX + keepHash)).not.toBeNull();
    expect(await bucket().get(AVATAR_KEY_PREFIX + '4'.repeat(64))).toBeNull();
  });

  it('keeps a fresh orphan inside the grace period', async () => {
    await bucket().put(AVATAR_KEY_PREFIX + '5'.repeat(64), PNG_BYTES);

    const r = await gcDrepAvatars({ db: db(), bucket: bucket(), nowMs: Date.now() });
    expect(r.deleted).toBe(0);
    expect(await bucket().get(AVATAR_KEY_PREFIX + '5'.repeat(64))).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/dreps/avatarStore.workers.test.ts`
Expected: FAIL (`gcDrepAvatars` is not exported).

- [ ] **Step 3: Implement the GC**

Append to `src/lib/dreps/avatarStore.ts` (and add `listReferencedImageHashes` to the existing import from `../db/dreps.js`):

```ts
// Grace period before an unreferenced object is deleted. Covers the window
// between an object landing in R2 and its DB row being visible to the GC's
// referenced-set read (mirrors the drep-metadata GC).
const AVATAR_GC_GRACE_MS = 24 * 60 * 60 * 1000;

export interface AvatarGcDeps {
  db: D1Database;
  bucket: R2Bucket;
  nowMs: number;
  /** Max deletions per run; the backlog drains over successive cron runs. */
  deleteLimit?: number;
}

/**
 * Deletes avatars/<hash> objects that no dreps row references anymore, once
 * they are older than the grace period. Paginates the R2 listing; bounded
 * deletions per run.
 */
export async function gcDrepAvatars(deps: AvatarGcDeps): Promise<{ scanned: number; deleted: number }> {
  const deleteLimit = deps.deleteLimit ?? 200;
  const referenced = await listReferencedImageHashes(deps.db);

  let scanned = 0;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await deps.bucket.list({ prefix: AVATAR_KEY_PREFIX, cursor });
    for (const obj of page.objects) {
      scanned++;
      if (deleted >= deleteLimit) break;
      const hash = obj.key.slice(AVATAR_KEY_PREFIX.length);
      if (referenced.has(hash)) continue;
      if (deps.nowMs - obj.uploaded.getTime() < AVATAR_GC_GRACE_MS) continue;
      await deps.bucket.delete(obj.key);
      deleted++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && deleted < deleteLimit);

  return { scanned, deleted };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/dreps/avatarStore.workers.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dreps/avatarStore.ts src/lib/dreps/avatarStore.workers.test.ts
git commit -m "feat: GC orphaned avatar objects in R2"
```

---

## Task 8: Cron wiring

**Files:**
- Modify: `workers/gov-sync/src/index.ts` (Env interface, runDrepSync)

- [ ] **Step 1: Wire the passes into runDrepSync**

In `workers/gov-sync/src/index.ts`:

Add the import after the `syncDreps` import:

```ts
import { storeDrepAvatars, gcDrepAvatars } from '../../../src/lib/dreps/avatarStore.js';
```

In the `Env` interface, after `DB: D1Database;`, add:

```ts
  AVATARS?: R2Bucket;
```

Replace the body of `runDrepSync` with:

```ts
async function runDrepSync(env: Env): Promise<void> {
  const { koios } = buildKoios(env);
  const r = await syncDreps({ koios, db: env.DB, fetchImpl: fetch, now: Date.now() });
  console.log(
    `[drep-sync] total=${r.total} updated=${r.updated} skipped=${r.skipped} anchorsFetched=${r.anchorsFetched} failed=${r.failed}`,
  );

  // Store new/changed avatars in R2 and GC orphaned objects. Non-fatal: a
  // failure here must not fail the DRep sync that already succeeded.
  if (env.AVATARS) {
    try {
      const a = await storeDrepAvatars({ db: env.DB, bucket: env.AVATARS, fetchImpl: fetch });
      console.log(`[drep-avatars] scanned=${a.scanned} stored=${a.stored} cleared=${a.cleared} failed=${a.failed}`);
      const gc = await gcDrepAvatars({ db: env.DB, bucket: env.AVATARS, nowMs: Date.now() });
      console.log(`[drep-avatars-gc] scanned=${gc.scanned} deleted=${gc.deleted}`);
    } catch (err) {
      console.error('[drep-avatars] pass failed', err);
    }
  } else {
    console.warn('[drep-avatars] AVATARS binding missing; skipping avatar store');
  }
}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npx vitest run --config vitest.workers.config.ts src/lib/dreps`
Expected: typecheck clean; all dreps workers tests pass.

- [ ] **Step 3: Commit**

```bash
git add workers/gov-sync/src/index.ts
git commit -m "feat: run the avatar store and GC passes on the drep-sync cron"
```

---

## Task 9: Serve route from R2

**Files:**
- Create: `src/lib/dreps/avatarServe.ts`
- Create: `src/pages/api/avatar/[hash].ts`
- Delete: `src/pages/api/avatar/[drepId].ts`, `src/pages/api/avatar/avatar.test.ts`
- Test: `src/lib/dreps/avatarServe.workers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/dreps/avatarServe.workers.test.ts`:

```ts
// Serve-core tests against the real miniflare R2 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { serveAvatar } from './avatarServe.js';
import { AVATAR_KEY_PREFIX } from './avatarStore.js';

const bucket = () => env.AVATARS as R2Bucket;
const HASH = '6'.repeat(64);
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

describe('serveAvatar', () => {
  it('serves a stored object with content-type and an immutable cache header', async () => {
    await bucket().put(AVATAR_KEY_PREFIX + HASH, BYTES, { httpMetadata: { contentType: 'image/webp' } });

    const res = await serveAvatar(bucket(), HASH);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it('404s on a miss', async () => {
    expect((await serveAvatar(bucket(), '7'.repeat(64))).status).toBe(404);
  });

  it('404s on a malformed hash without touching the bucket', async () => {
    expect((await serveAvatar(bucket(), 'not-a-hash')).status).toBe(404);
    expect((await serveAvatar(bucket(), ('8'.repeat(63)) + 'X')).status).toBe(404);
    expect((await serveAvatar(bucket(), undefined)).status).toBe(404);
  });

  it('404s when the bucket binding is missing', async () => {
    expect((await serveAvatar(undefined, HASH)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/dreps/avatarServe.workers.test.ts`
Expected: FAIL (cannot resolve `./avatarServe.js`).

- [ ] **Step 3: Write the serve core**

Create `src/lib/dreps/avatarServe.ts`:

```ts
/// <reference types="@cloudflare/workers-types" />
// Serve core for /api/avatar/<hash>: a plain R2 read. The URL is content
// addressed (sha256 of the bytes), so the response is immutable-cacheable and
// no validation beyond the hash shape is needed at request time. All download
// hardening runs at store time (see avatarStore.ts).
import { AVATAR_KEY_PREFIX } from './avatarStore.js';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HASH_RE = /^[0-9a-f]{64}$/;

/** Serves one stored avatar; any invalid input or miss is a 404, never a 500. */
export async function serveAvatar(bucket: R2Bucket | undefined, hash: string | undefined): Promise<Response> {
  if (!bucket || !hash || !HASH_RE.test(hash)) return new Response('not found', { status: 404 });

  const obj = await bucket.get(AVATAR_KEY_PREFIX + hash);
  if (!obj) return new Response('not found', { status: 404 });

  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/dreps/avatarServe.workers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Swap the route**

Delete the old route and its node-mode test (their behavior, upstream proxying, no longer exists):

```bash
git rm src/pages/api/avatar/[drepId].ts src/pages/api/avatar/avatar.test.ts
```

Create `src/pages/api/avatar/[hash].ts`:

```ts
// GET /api/avatar/:hash
//
// Serves a self-hosted DRep avatar from R2, content addressed by the sha256 of
// its bytes (written by the gov-sync avatar store pass). No upstream fetch
// happens at request time: visitors never touch the third-party image host.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { serveAvatar } from '@/lib/dreps/avatarServe';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  return serveAvatar(env.AVATARS as R2Bucket | undefined, params.hash);
};
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite passes (the deleted node test is gone, the new workers tests pass).

- [ ] **Step 7: Commit**

```bash
git add -A src/pages/api/avatar src/lib/dreps/avatarServe.ts src/lib/dreps/avatarServe.workers.test.ts
git commit -m "feat: serve DRep avatars from R2 by content hash"
```

---

## Task 10: Consumers switch to imageHash

**Files:**
- Modify: `src/lib/forum/author.ts` (AuthorDescriptor + describeAuthor)
- Modify: `src/components/AuthorIdentity.astro`
- Modify: `src/pages/dreps/index.astro` (descriptorFor)
- Modify: `src/components/ga/TopParticipantsCard.astro` (descriptorFor)
- Modify: `src/components/ga/GaPositions.astro` (descriptorFor)
- Modify: `src/pages/dreps/[drepId].astro` (header overlay + JSON-LD image)

- [ ] **Step 1: Descriptor contract**

In `src/lib/forum/author.ts`, in `AuthorDescriptor`, replace

```ts
  /** True when the drep has a synced CIP-119 image URL to attempt via the proxy. */
  hasImage?: boolean;
```

with

```ts
  /** Content hash of the stored avatar in R2 (drives /api/avatar/<hash>), or null/absent when not stored. */
  imageHash?: string | null;
```

And in `describeAuthor`, replace `hasImage: !!drep?.imageUrl,` with:

```ts
    imageHash: drep?.imageContentHash ?? null,
```

- [ ] **Step 2: AuthorIdentity**

In `src/components/AuthorIdentity.astro`, replace

```ts
const { displayName, drepId, hasImage, badges = [], isSystem = false } = author;

// Overlay the proxied avatar only when a synced drep image URL exists.
const showImage = !isSystem && !!drepId && !!hasImage;
```

with

```ts
const { displayName, drepId, imageHash, badges = [], isSystem = false } = author;

// Overlay the stored avatar only when one exists in R2 (content addressed).
const showImage = !isSystem && !!imageHash;
```

And in the markup, replace the overlay style

```astro
        style={`background-image:url(/api/avatar/${drepId})`}
```

with

```astro
        style={`background-image:url(/api/avatar/${imageHash})`}
```

Also update the component's header comment: the avatar overlay is now the
self-hosted R2 copy (`/api/avatar/<hash>`), not a proxied upstream image; the
layering and 404-falls-through-to-identicon behavior is unchanged.

- [ ] **Step 3: Descriptor builders**

In `src/pages/dreps/index.astro` (`descriptorFor`), replace `hasImage: !!d.imageUrl,` with:

```ts
  imageHash: d.imageContentHash,
```

In `src/components/ga/TopParticipantsCard.astro` and `src/components/ga/GaPositions.astro` (both `descriptorFor`), replace `hasImage: !!d?.imageUrl,` with:

```ts
    imageHash: d?.imageContentHash ?? null,
```

- [ ] **Step 4: DRep profile page**

In `src/pages/dreps/[drepId].astro`:

In the JSON-LD, replace

```ts
      ...(drep.imageUrl ? { image: `${siteOrigin}/api/avatar/${drep.drepId}` } : {}),
```

with

```ts
      ...(drep.imageContentHash ? { image: `${siteOrigin}/api/avatar/${drep.imageContentHash}` } : {}),
```

In the header avatar, replace

```astro
        {drep.imageUrl && (
          <span style={`position:absolute;inset:0;background:center/cover no-repeat url(/api/avatar/${drep.drepId});`}></span>
        )}
```

with

```astro
        {drep.imageContentHash && (
          <span style={`position:absolute;inset:0;background:center/cover no-repeat url(/api/avatar/${drep.imageContentHash});`}></span>
        )}
```

- [ ] **Step 5: Verify nothing still uses the old contract**

Run:
```bash
grep -rn "hasImage" src/ && echo "FAIL: hasImage remains" || echo "ok"
grep -rn "api/avatar/\${drepId}\|api/avatar/\${drep.drepId}" src/ && echo "FAIL: drepId avatar URL remains" || echo "ok"
npm run typecheck && npm run build
```
Expected: both greps print `ok`; typecheck and build pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/forum/author.ts src/components/AuthorIdentity.astro src/pages/dreps/index.astro src/components/ga/TopParticipantsCard.astro src/components/ga/GaPositions.astro "src/pages/dreps/[drepId].astro"
git commit -m "feat: render avatars from the R2 content hash"
```

---

## Task 11: Full verification and PR

**Files:** none (verification and PR only).

- [ ] **Step 1: Full gates**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: all PASS. Do NOT run `biome format` repo-wide (lint is the gate, the repo is not format-clean).

- [ ] **Step 2: Optional local smoke**

Run `npm run sync:dev`, trigger the `0 */6 * * *` cron via the printed `/__scheduled` URL, and watch for the `[drep-avatars]` log line; then `npm run dev` and open `/dreps`. DReps whose avatar was stored show photos; the rest show identicons.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/dreps-r2-avatars
gh pr create --title "feat: self-hosted DRep avatars in R2" --body "$(cat <<'EOF'
- Download each DRep's CIP-119 avatar once during the drep-sync cron and store it in R2, content addressed by the sha256 of its bytes; the existing download hardening (https-only, timeout, type allowlist, 256 KB cap) moves to store time
- Serve avatars from R2 at /api/avatar/<hash> with an immutable cache; no request-time fetch to third-party hosts anymore (faster, and visitor IPs never reach the image host)
- Resolve ipfs:// profile images through the IPFS gateway instead of dropping them, so far more DReps get a real photo instead of the identicon
- Re-download only when the on-chain image URL changes; a paced GC pass deletes orphaned R2 objects after a grace period
- New AVATARS R2 buckets/bindings (mainnet + preprod) for the app and the cron worker; migration adds image_content_hash/image_stored_url to dreps
EOF
)"
```

Expected: PR created. STOP and return the PR URL; do not merge.

---

## Spec coverage check

- R2 buckets/bindings/types/test config: Task 1.
- Schema (0017) + Drep plumbing + REPLACE-preservation: Tasks 2, 3.
- Work-queue/GC SQL: Task 4.
- ipfs image resolution: Task 5.
- Avatar store pass (hardening at store time, dedup, per-row failure isolation, clear pass): Task 6.
- GC pass (grace period, pagination, bounded deletes): Task 7.
- Cron wiring (non-fatal, binding-missing skip): Task 8.
- Serve route (hash validation, immutable cache, no upstream): Task 9.
- Consumers (descriptor, identity component, directory, GA cards, profile page incl. JSON-LD): Task 10.
- Local dev story: no task needed (the binding in wrangler.toml gives `astro dev`/`sync:dev` a local Miniflare R2; empty bucket degrades to identicons). Smoke covered in Task 11.
- Edge cases: missing binding (Tasks 8, 9), failed download (Task 6), removed image + lingering hash (Tasks 4, 6, 7), duplicate bytes (Task 6).
