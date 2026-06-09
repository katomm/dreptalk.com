# /dreps front end (nav, footer, concentration donut) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move DReps into the top navbar and Help into the footer, and add an interactive voting power concentration donut to /dreps that shows the smallest coalition of DReps whose combined power crosses a live ratification threshold.

**Architecture:** A new generic `app_meta` D1 table stores live DRep thresholds pulled from Koios epoch_params during the existing drep-sync cron. The /dreps page computes a compact concentration summary (BigInt math, server side) from the active non-special DReps and hands it to a React island that renders an SVG donut plus a threshold slider. Pure logic lives in testable modules; the island and page are thin.

**Tech Stack:** Astro 6 (SSR on Cloudflare Workers), React islands via @astrojs/react, D1, Zod, Vitest (node pool for pure logic, cloudflare workers pool for D1).

---

## File structure

Created:
- `migrations/0016_app_meta.sql` (generic key/value table)
- `src/lib/db/appMeta.ts` + `src/lib/db/appMeta.workers.test.ts`
- `src/lib/dreps/special.ts` (special DRep ids)
- `src/lib/dreps/thresholds.ts` + `src/lib/dreps/thresholds.workers.test.ts`
- `src/lib/dreps/concentration.ts` + `src/lib/dreps/concentration.test.ts`
- `src/lib/dreps/concentrationView.ts` + `src/lib/dreps/concentrationView.test.ts`
- `src/components/DrepConcentration.tsx`
- `src/lib/koios/epochParams.test.ts`

Modified:
- `src/layouts/Layout.astro` (navbar + footer)
- `src/lib/koios/client.ts` (epochParams method + schema)
- `src/lib/db/dreps.ts` (exclude special ids in listDreps, add listDrepsForConcentration)
- `src/lib/db/dreps.workers.test.ts` (exclusion + concentration query tests)
- `workers/gov-sync/src/index.ts` (call syncDrepThresholds in runDrepSync)
- `src/pages/dreps/index.astro` (compute concentration, mount island)
- `src/styles/global.css` (donut styles)

---

## Task 1: Navbar and footer

**Files:**
- Modify: `src/layouts/Layout.astro:38-42` (navLinks), `src/layouts/Layout.astro:153-154` (footer links)

- [ ] **Step 1: Swap the nav and footer links**

In `src/layouts/Layout.astro`, replace the `navLinks` array (currently Governance Actions, Discussions, Help):

```astro
const navLinks = [
  { label: 'Governance Actions', href: '/c/governance-actions' },
  { label: 'Discussions', href: '/discussions' },
  { label: 'DReps', href: '/dreps' },
];
```

And in the footer nav, add Help before Privacy. Replace the opening of the footer links block:

```astro
        <nav class="site-footer__links" aria-label="Footer">
          <a href="/help">Help</a>
          <a href="/privacy">Privacy</a>
          <a href="/imprint">Imprint</a>
```

(Leave the GitHub anchor that follows unchanged.)

- [ ] **Step 2: Verify the app type-checks**

Run: `npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/layouts/Layout.astro
git commit -m "feat: move DReps into navbar and Help into the footer"
```

---

## Task 2: app_meta table and accessor

**Files:**
- Create: `migrations/0016_app_meta.sql`
- Create: `src/lib/db/appMeta.ts`
- Test: `src/lib/db/appMeta.workers.test.ts`

- [ ] **Step 1: Write the migration**

Create `migrations/0016_app_meta.sql`:

```sql
-- Generic key/value metadata for the app, stored in D1. One row per key; values
-- are opaque strings (callers JSON-encode structured data). First use: the live
-- DRep voting thresholds pulled from Koios epoch_params during the DRep sync, so
-- the /dreps concentration view can show current, not hardcoded, thresholds.
CREATE TABLE app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/db/appMeta.workers.test.ts`:

```ts
// app_meta D1 access tests; run in real workerd via @cloudflare/vitest-pool-workers
// with all migrations applied (so 0016 creates the table).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getAppMeta, setAppMeta } from './appMeta.js';

const db = () => env.DB;

describe('appMeta', () => {
  it('returns null for a missing key', async () => {
    expect(await getAppMeta(db(), 'nope')).toBeNull();
  });

  it('round-trips a value and its updated_at', async () => {
    await setAppMeta(db(), 'k1', '{"a":1}', 1_700_000_000);
    expect(await getAppMeta(db(), 'k1')).toEqual({ value: '{"a":1}', updatedAt: 1_700_000_000 });
  });

  it('overwrites an existing key', async () => {
    await setAppMeta(db(), 'k2', 'first', 1);
    await setAppMeta(db(), 'k2', 'second', 2);
    expect(await getAppMeta(db(), 'k2')).toEqual({ value: 'second', updatedAt: 2 });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/appMeta.workers.test.ts`
Expected: FAIL (cannot resolve `./appMeta.js`).

- [ ] **Step 4: Write the accessor**

Create `src/lib/db/appMeta.ts`:

```ts
/// <reference types="@cloudflare/workers-types" />
// Generic key/value access for the app_meta table. Values are opaque strings;
// callers JSON-encode structured data. Parameterized; never interpolated SQL.

export interface AppMetaRow {
  value: string;
  updatedAt: number;
}

/** Reads one app_meta value by key, or null if absent. */
export async function getAppMeta(db: D1Database, key: string): Promise<AppMetaRow | null> {
  const row = await db
    .prepare('SELECT value, updated_at FROM app_meta WHERE key = ?')
    .bind(key)
    .first<{ value: string; updated_at: number }>();
  return row ? { value: row.value, updatedAt: row.updated_at } : null;
}

/** Inserts or replaces one app_meta value. */
export async function setAppMeta(db: D1Database, key: string, value: string, updatedAt: number): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(key, value, updatedAt)
    .run();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/appMeta.workers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/0016_app_meta.sql src/lib/db/appMeta.ts src/lib/db/appMeta.workers.test.ts
git commit -m "feat: add generic app_meta key/value table and accessor"
```

---

## Task 3: Koios epochParams()

**Files:**
- Modify: `src/lib/koios/client.ts` (add schema near the other schemas, add method inside the returned object next to `drepList`)
- Test: `src/lib/koios/epochParams.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/koios/epochParams.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createKoiosClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ROW = {
  epoch_no: 500,
  dvt_motion_no_confidence: 0.67,
  dvt_committee_normal: 0.67,
  dvt_committee_no_confidence: 0.6,
  dvt_update_to_constitution: 0.75,
  dvt_hard_fork_initiation: 0.6,
  dvt_p_p_network_group: 0.67,
  dvt_p_p_economic_group: 0.67,
  dvt_p_p_technical_group: 0.67,
  dvt_p_p_gov_group: 0.75,
  dvt_treasury_withdrawal: 0.67,
};

describe('createKoiosClient.epochParams', () => {
  it('parses dvt thresholds from the latest epoch params', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([ROW]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });
    const p = await client.epochParams();
    expect(p?.dvt_treasury_withdrawal).toBe(0.67);
    expect(p?.dvt_update_to_constitution).toBe(0.75);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.koios.rest/api/v1/epoch_params?order=epoch_no.desc&limit=1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('returns null when Koios returns no rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = createKoiosClient({ baseUrl: 'https://api.koios.rest/api/v1', fetchImpl });
    expect(await client.epochParams()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.config.ts src/lib/koios/epochParams.test.ts`
Expected: FAIL (`client.epochParams is not a function`).

- [ ] **Step 3: Add the schema and method**

In `src/lib/koios/client.ts`, add this schema next to the other row schemas (for example after `committeeInfoRowSchema`, before `export function createKoiosClient`):

```ts
// Current-epoch protocol parameters: only the DRep voting threshold (dvt_*)
// fields the concentration view needs. Fractions in 0..1. Tolerant of nulls and
// of the many other params Koios returns.
const epochParamsRowSchema = z
  .object({
    dvt_motion_no_confidence: z.number().nullable().optional(),
    dvt_committee_normal: z.number().nullable().optional(),
    dvt_committee_no_confidence: z.number().nullable().optional(),
    dvt_update_to_constitution: z.number().nullable().optional(),
    dvt_hard_fork_initiation: z.number().nullable().optional(),
    dvt_p_p_network_group: z.number().nullable().optional(),
    dvt_p_p_economic_group: z.number().nullable().optional(),
    dvt_p_p_technical_group: z.number().nullable().optional(),
    dvt_p_p_gov_group: z.number().nullable().optional(),
    dvt_treasury_withdrawal: z.number().nullable().optional(),
  })
  .passthrough();

export type EpochParams = z.infer<typeof epochParamsRowSchema>;
```

Then inside the object returned by `createKoiosClient` (next to `drepList`), add the method:

```ts
    // Latest-epoch protocol parameters. Used to read the live DRep voting
    // thresholds (dvt_*) for the concentration view. Returns null on no rows.
    async epochParams(): Promise<EpochParams | null> {
      const path = '/epoch_params?order=epoch_no.desc&limit=1';
      const data = await request(path, { method: 'GET' });
      return z.array(epochParamsRowSchema).parse(data)[0] ?? null;
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.config.ts src/lib/koios/epochParams.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/koios/client.ts src/lib/koios/epochParams.test.ts
git commit -m "feat: add Koios epochParams() for live DRep thresholds"
```

---

## Task 4: Threshold sync and read

**Files:**
- Create: `src/lib/dreps/thresholds.ts`
- Test: `src/lib/dreps/thresholds.workers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/dreps/thresholds.workers.test.ts`:

```ts
// Threshold sync/read tests; run in real workerd so app_meta is a real D1 table.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncDrepThresholds, getDrepThresholds, thresholdsFromEpochParams } from './thresholds.js';
import type { EpochParams } from '../koios/client.js';

const db = () => env.DB;

const PARAMS: EpochParams = {
  dvt_motion_no_confidence: 0.67,
  dvt_committee_normal: 0.67,
  dvt_committee_no_confidence: 0.6,
  dvt_update_to_constitution: 0.75,
  dvt_hard_fork_initiation: 0.6,
  dvt_p_p_network_group: 0.67,
  dvt_p_p_economic_group: 0.67,
  dvt_p_p_technical_group: 0.67,
  dvt_p_p_gov_group: 0.75,
  dvt_treasury_withdrawal: 0.67,
};

describe('thresholdsFromEpochParams', () => {
  it('derives distinct sorted markers', () => {
    expect(thresholdsFromEpochParams(PARAMS).markers).toEqual([0.6, 0.67, 0.75]);
  });
});

describe('syncDrepThresholds + getDrepThresholds', () => {
  it('returns null before any sync', async () => {
    expect(await getDrepThresholds(db())).toBeNull();
  });

  it('stores and reads back thresholds with asOf', async () => {
    const ok = await syncDrepThresholds({ koios: { epochParams: async () => PARAMS }, db: db(), now: 1_700_000_000 });
    expect(ok).toBe(true);
    const stored = await getDrepThresholds(db());
    expect(stored?.markers).toEqual([0.6, 0.67, 0.75]);
    expect(stored?.asOf).toBe(1_700_000_000);
    expect(stored?.thresholds.dvt_treasury_withdrawal).toBe(0.67);
  });

  it('returns false and does not write when Koios has no params', async () => {
    const ok = await syncDrepThresholds({ koios: { epochParams: async () => null }, db: db(), now: 2 });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/dreps/thresholds.workers.test.ts`
Expected: FAIL (cannot resolve `./thresholds.js`).

- [ ] **Step 3: Write the module**

Create `src/lib/dreps/thresholds.ts`:

```ts
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
export const DEFAULT_THRESHOLD = 0.67;

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
    if (!Array.isArray(parsed.markers) || parsed.markers.length === 0) return null;
    return { thresholds: parsed.thresholds, markers: parsed.markers, asOf: row.updatedAt };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/dreps/thresholds.workers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dreps/thresholds.ts src/lib/dreps/thresholds.workers.test.ts
git commit -m "feat: sync and read live DRep voting thresholds from Koios"
```

---

## Task 5: Wire threshold sync into the drep-sync cron

**Files:**
- Modify: `workers/gov-sync/src/index.ts:24` (import), `workers/gov-sync/src/index.ts:120-126` (runDrepSync)

- [ ] **Step 1: Add the import**

In `workers/gov-sync/src/index.ts`, after the existing `import { syncDreps } from '../../../src/lib/dreps/sync.js';` line, add:

```ts
import { syncDrepThresholds } from '../../../src/lib/dreps/thresholds.js';
```

- [ ] **Step 2: Call it in runDrepSync**

Replace the body of `runDrepSync` with:

```ts
async function runDrepSync(env: Env): Promise<void> {
  const { koios } = buildKoios(env);
  const r = await syncDreps({ koios, db: env.DB, fetchImpl: fetch, now: Date.now() });
  console.log(
    `[drep-sync] total=${r.total} updated=${r.updated} skipped=${r.skipped} anchorsFetched=${r.anchorsFetched} failed=${r.failed}`,
  );

  // Refresh the live DRep voting thresholds (lean: one extra Koios call per run).
  // Non-fatal: a failure here must not fail the DRep sync that already succeeded.
  try {
    const wrote = await syncDrepThresholds({ koios, db: env.DB, now: Date.now() });
    console.log(`[drep-thresholds] wrote=${wrote}`);
  } catch (err) {
    console.error('[drep-thresholds] refresh failed', err);
  }
}
```

- [ ] **Step 3: Verify the workers tests still pass and types are clean**

Run: `npm run typecheck && npx vitest run --config vitest.workers.config.ts src/lib/dreps`
Expected: PASS (typecheck clean; drep sync and threshold tests pass).

- [ ] **Step 4: Commit**

```bash
git add workers/gov-sync/src/index.ts
git commit -m "feat: refresh DRep thresholds during the drep-sync cron"
```

---

## Task 6: Exclude special DReps; add concentration query

**Files:**
- Create: `src/lib/dreps/special.ts`
- Modify: `src/lib/db/dreps.ts` (import, listDreps WHERE, new listDrepsForConcentration)
- Test: `src/lib/db/dreps.workers.test.ts` (add cases)

- [ ] **Step 1: Write the special ids module**

Create `src/lib/dreps/special.ts`:

```ts
// The two predefined pseudo-DReps Koios returns in drep_list. They are not real
// voters: "always abstain" stake is excluded from active voting stake, and
// "always no confidence" is a standing no. Both are excluded from the directory
// and the concentration view so the figures reflect real DReps.
export const SPECIAL_DREP_IDS = ['drep_always_abstain', 'drep_always_no_confidence'] as const;
```

- [ ] **Step 2: Write the failing tests**

In `src/lib/db/dreps.workers.test.ts`, add the import at the top (next to the existing imports):

```ts
import { listDrepsForConcentration } from './dreps.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';
```

Then add this describe block at the end of the file:

```ts
describe('special DReps', () => {
  it('listDreps excludes the predefined pseudo-DReps', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'drepreal', name: 'Real', votingPower: '100' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: SPECIAL_DREP_IDS[0], name: 'AbstainPseudo', votingPower: '999999999999' });

    const rows = await listDreps(db(), { activeOnly: true, limit: 50, offset: 0 });
    const ids = rows.map((r) => r.drepId);
    expect(ids).toContain('drepreal');
    expect(ids).not.toContain(SPECIAL_DREP_IDS[0]);
  });

  it('listDrepsForConcentration returns active non-special DReps ordered by power desc', async () => {
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'cbig', name: 'Big', active: true, votingPower: '300' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'csmall', name: 'Small', active: true, votingPower: '100' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: 'cinactive', name: 'Inactive', active: false, votingPower: '500' });
    await upsertDrep(db(), { ...BASE_ARGS, drepId: SPECIAL_DREP_IDS[1], name: 'NoConfPseudo', active: true, votingPower: '999' });

    const rows = await listDrepsForConcentration(db());
    const ids = rows.map((r) => r.drepId);
    expect(ids).toEqual(['cbig', 'csmall']);
    expect(rows[0]).toEqual({ drepId: 'cbig', name: 'Big', votingPower: '300' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/dreps.workers.test.ts`
Expected: FAIL (`listDrepsForConcentration` is not exported; listDreps still returns the special id).

- [ ] **Step 4: Implement the exclusion and the query**

In `src/lib/db/dreps.ts`, add to the imports at the top:

```ts
import { SPECIAL_DREP_IDS } from '../dreps/special.js';
```

In `listDreps`, after the `if (opts.activeOnly) where.push('active = 1');` line and before the query filter is built, add the special-id exclusion:

```ts
  // Never list the predefined pseudo-DReps (always-abstain / always-no-confidence).
  where.push(`drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})`);
  binds.push(...SPECIAL_DREP_IDS);
```

Then add the concentration query and its row type at the end of the file:

```ts
export interface DrepPowerRow {
  drepId: string;
  name: string | null;
  votingPower: string | null;
}

/**
 * Active, non-special DReps with only the fields the concentration view needs,
 * ordered by numeric voting power desc. No pagination: the whole active set
 * (about 2k single-column rows) feeds one server-side aggregate, and the page
 * is edge cached so only cold renders pay it.
 */
export async function listDrepsForConcentration(db: D1Database): Promise<DrepPowerRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT drep_id, name, voting_power FROM dreps
         WHERE active = 1 AND drep_id NOT IN (${sqlPlaceholders(SPECIAL_DREP_IDS)})
         ORDER BY CAST(voting_power AS INTEGER) DESC`,
      )
      .bind(...SPECIAL_DREP_IDS)
      .all<{ drep_id: string; name: string | null; voting_power: string | null }>()
  ).results ?? [];
  return rows.map((r) => ({ drepId: r.drep_id, name: r.name, votingPower: r.voting_power }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/dreps.workers.test.ts`
Expected: PASS (existing tests plus the two new cases).

- [ ] **Step 6: Commit**

```bash
git add src/lib/dreps/special.ts src/lib/db/dreps.ts src/lib/db/dreps.workers.test.ts
git commit -m "feat: exclude pseudo-DReps and add concentration query"
```

---

## Task 7: Concentration computation (pure)

**Files:**
- Create: `src/lib/dreps/concentration.ts`
- Test: `src/lib/dreps/concentration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/dreps/concentration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeConcentration, type ConcentrationInput } from './concentration.js';

const mk = (id: string, power: bigint): ConcentrationInput => ({ drepId: id, name: id, power });

describe('computeConcentration', () => {
  it('returns an empty result for no DReps', () => {
    const c = computeConcentration([]);
    expect(c.drepCount).toBe(0);
    expect(c.topK).toEqual([]);
    expect(c.byPercent).toHaveLength(101);
    expect(c.byPercent[100]).toEqual({ count: 0, cumPct: 0 });
  });

  it('computes pct and a single-DRep coalition for a dominant DRep', () => {
    const c = computeConcentration([mk('a', 80n), mk('b', 20n)]);
    expect(c.topK[0].pct).toBe(80);
    expect(c.byPercent[67].count).toBe(1);
    expect(c.byPercent[80].count).toBe(1);
    expect(c.byPercent[81].count).toBe(2);
  });

  it('byPercent count is monotonic and reaches drepCount at 100%', () => {
    const c = computeConcentration([mk('a', 10n), mk('b', 10n), mk('c', 10n), mk('d', 10n)]);
    for (let p = 1; p <= 100; p++) {
      expect(c.byPercent[p].count).toBeGreaterThanOrEqual(c.byPercent[p - 1].count);
    }
    expect(c.byPercent[100].count).toBe(4);
  });

  it('treats null/negative power as zero', () => {
    const c = computeConcentration([mk('a', 100n), { drepId: 'b', name: 'b', power: -5n }]);
    expect(c.byPercent[100].count).toBe(1);
  });

  it('uses BigInt so large lovelace sums do not lose precision', () => {
    const big = 9_000_000_000_000_000n; // > Number.MAX_SAFE_INTEGER
    const c = computeConcentration([mk('a', big), mk('b', big)]);
    expect(c.byPercent[50].count).toBe(1);
    expect(c.byPercent[51].count).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.config.ts src/lib/dreps/concentration.test.ts`
Expected: FAIL (cannot resolve `./concentration.js`).

- [ ] **Step 3: Write the module**

Create `src/lib/dreps/concentration.ts`:

```ts
// Pure voting-power concentration math for the /dreps donut. No DB, no env.
// Input is the active, non-special DReps sorted by voting power desc; output is
// a small, JSON-serializable summary the donut island renders. Sums use BigInt
// because total DRep voting power in lovelace exceeds Number.MAX_SAFE_INTEGER.
import { formatAda } from '../forum/view.js';

export interface ConcentrationInput {
  drepId: string;
  name: string | null;
  power: bigint;
}

export interface ConcentrationTop {
  drepId: string;
  name: string | null;
  powerLabel: string;
  pct: number;
}

export interface ConcentrationPoint {
  count: number; // minimum DReps to reach this percent
  cumPct: number; // their actual cumulative share (>= the percent)
}

export interface Concentration {
  drepCount: number;
  totalLabel: string;
  topK: ConcentrationTop[];
  byPercent: ConcentrationPoint[]; // length 101, index = percent 0..100
}

const TOP_K = 12;

/** Two-decimal percent of `part` out of `total`, using BigInt to avoid overflow. */
function pctOf(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 10000n) / total) / 100;
}

function emptyByPercent(): ConcentrationPoint[] {
  return Array.from({ length: 101 }, () => ({ count: 0, cumPct: 0 }));
}

/** Computes the concentration summary from DReps pre-sorted by power desc. */
export function computeConcentration(dreps: ConcentrationInput[]): Concentration {
  const total = dreps.reduce((acc, d) => acc + (d.power > 0n ? d.power : 0n), 0n);
  if (dreps.length === 0 || total <= 0n) {
    return { drepCount: dreps.length, totalLabel: formatAda('0'), topK: [], byPercent: emptyByPercent() };
  }

  const topK = dreps.slice(0, TOP_K).map((d) => ({
    drepId: d.drepId,
    name: d.name,
    powerLabel: formatAda((d.power > 0n ? d.power : 0n).toString()),
    pct: pctOf(d.power > 0n ? d.power : 0n, total),
  }));

  // Two-pointer over the sorted list: as the target percent rises, the minimum
  // coalition size is non-decreasing, so `idx` only ever advances.
  const byPercent: ConcentrationPoint[] = [{ count: 0, cumPct: 0 }];
  let idx = 0;
  let cum = 0n;
  for (let p = 1; p <= 100; p++) {
    while (idx < dreps.length && cum * 100n < total * BigInt(p)) {
      cum += dreps[idx].power > 0n ? dreps[idx].power : 0n;
      idx++;
    }
    byPercent[p] = { count: idx, cumPct: pctOf(cum, total) };
  }

  return { drepCount: dreps.length, totalLabel: formatAda(total.toString()), topK, byPercent };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.config.ts src/lib/dreps/concentration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dreps/concentration.ts src/lib/dreps/concentration.test.ts
git commit -m "feat: add pure voting-power concentration computation"
```

---

## Task 8: Concentration view math (pure)

**Files:**
- Create: `src/lib/dreps/concentrationView.ts`
- Test: `src/lib/dreps/concentrationView.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/dreps/concentrationView.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { coalitionAt, snapThreshold, buildSegments, summarySentence } from './concentrationView.js';
import type { ConcentrationPoint, ConcentrationTop } from './concentration.js';

describe('snapThreshold', () => {
  it('snaps to a nearby marker', () => {
    expect(snapThreshold(66, [60, 67, 75])).toBe(67);
  });
  it('leaves values far from any marker untouched', () => {
    expect(snapThreshold(50, [60, 67, 75])).toBe(50);
  });
});

describe('coalitionAt', () => {
  const byPercent: ConcentrationPoint[] = Array.from({ length: 101 }, (_, p) => ({ count: p, cumPct: p }));
  it('clamps and indexes by percent', () => {
    expect(coalitionAt(byPercent, 67)).toEqual({ count: 67, cumPct: 67 });
    expect(coalitionAt(byPercent, 200)).toEqual({ count: 100, cumPct: 100 });
  });
});

describe('buildSegments', () => {
  const topK: ConcentrationTop[] = [
    { drepId: 'a', name: 'A', powerLabel: '', pct: 30 },
    { drepId: 'b', name: 'B', powerLabel: '', pct: 25 },
    { drepId: 'c', name: 'C', powerLabel: '', pct: 20 },
  ];
  it('uses individual top slices when the coalition fits in top-K', () => {
    expect(buildSegments(topK, { count: 2, cumPct: 55 })).toEqual([
      { pct: 30, kind: 'top' },
      { pct: 25, kind: 'top' },
      { pct: 45, kind: 'remainder' },
    ]);
  });
  it('adds a coalitionRest slice when the coalition exceeds top-K', () => {
    expect(buildSegments(topK, { count: 5, cumPct: 90 })).toEqual([
      { pct: 30, kind: 'top' },
      { pct: 25, kind: 'top' },
      { pct: 20, kind: 'top' },
      { pct: 15, kind: 'coalitionRest' },
      { pct: 10, kind: 'remainder' },
    ]);
  });
});

describe('summarySentence', () => {
  it('formats count and percent', () => {
    expect(summarySentence(7, 67)).toBe('Top 7 DReps hold 67% of active DRep voting power');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.config.ts src/lib/dreps/concentrationView.test.ts`
Expected: FAIL (cannot resolve `./concentrationView.js`).

- [ ] **Step 3: Write the module**

Create `src/lib/dreps/concentrationView.ts`:

```ts
// Pure rendering math for the DRep concentration donut. No React, no DOM, so it
// is unit-tested in the node pool; the .tsx island only wires state to these.
import type { ConcentrationPoint, ConcentrationTop } from './concentration.js';

export interface DonutSegment {
  pct: number;
  kind: 'top' | 'coalitionRest' | 'remainder';
}

/** Clamps a percent into 0..100 and returns the coalition point at that percent. */
export function coalitionAt(byPercent: ConcentrationPoint[], pct: number): ConcentrationPoint {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return byPercent[p] ?? { count: 0, cumPct: 0 };
}

/** Snaps a slider value to the nearest marker within `tolerance`, else returns it. */
export function snapThreshold(value: number, markers: number[], tolerance = 2): number {
  let best = value;
  let bestDist = tolerance + 1;
  for (const m of markers) {
    const d = Math.abs(m - value);
    if (d <= tolerance && d < bestDist) {
      best = m;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Builds the donut segments for a coalition: the top DReps inside it as
 * individual slices, any coalition members beyond the top-K as one slice, and
 * the rest of the ring as the muted remainder. Percentages are shares of total.
 */
export function buildSegments(topK: ConcentrationTop[], coalition: ConcentrationPoint): DonutSegment[] {
  const inCoalition = topK.slice(0, Math.min(coalition.count, topK.length));
  const segments: DonutSegment[] = inCoalition.map((t) => ({ pct: t.pct, kind: 'top' }));
  const topSum = inCoalition.reduce((acc, t) => acc + t.pct, 0);

  let highlighted = topSum;
  if (coalition.count > topK.length) {
    segments.push({ pct: Math.max(0, coalition.cumPct - topSum), kind: 'coalitionRest' });
    highlighted = coalition.cumPct;
  }

  segments.push({ pct: Math.max(0, 100 - highlighted), kind: 'remainder' });
  return segments;
}

/** Human summary, e.g. "Top 7 DReps hold 67% of active DRep voting power". */
export function summarySentence(count: number, pct: number): string {
  return `Top ${count.toLocaleString('en-US')} DReps hold ${pct}% of active DRep voting power`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.config.ts src/lib/dreps/concentrationView.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dreps/concentrationView.ts src/lib/dreps/concentrationView.test.ts
git commit -m "feat: add pure donut segment and snap math"
```

---

## Task 9: Donut island and styles

**Files:**
- Create: `src/components/DrepConcentration.tsx`
- Modify: `src/styles/global.css` (append the donut block)

No unit test: the testable logic lives in `concentrationView.ts` (Task 8). This task adds the thin React island and its CSS, verified by typecheck and build.

- [ ] **Step 1: Write the island**

Create `src/components/DrepConcentration.tsx`:

```tsx
import { useMemo, useState } from 'react';
import type { Concentration } from '@/lib/dreps/concentration.js';
import { coalitionAt, snapThreshold, buildSegments, summarySentence, type DonutSegment } from '@/lib/dreps/concentrationView.js';

interface Props {
  topK: Concentration['topK'];
  byPercent: Concentration['byPercent'];
  drepCount: number;
  totalLabel: string;
  markersPct: number[]; // e.g. [60, 67, 75]
  defaultThresholdPct: number; // e.g. 67
  thresholdsAsOf: string | null; // formatted date or null
}

const SLIDER_MIN = 40;
const SLIDER_MAX = 90;
const R = 80; // donut radius in the 200x200 viewBox
const STROKE = 22;
const C = 2 * Math.PI * R;

// Decreasing-opacity accent shades for the individual top DRep slices.
function topTone(i: number): string {
  const op = Math.max(0.4, 1 - i * 0.06);
  return `color-mix(in srgb, var(--accent) ${Math.round(op * 100)}%, var(--surface))`;
}

function toneFor(kind: DonutSegment['kind'], index: number): string {
  if (kind === 'top') return topTone(index);
  if (kind === 'coalitionRest') return 'color-mix(in srgb, var(--accent) 30%, var(--surface))';
  return 'var(--border)';
}

export default function DrepConcentration(props: Props) {
  const { topK, byPercent, drepCount, totalLabel, markersPct, defaultThresholdPct, thresholdsAsOf } = props;
  const [threshold, setThreshold] = useState(defaultThresholdPct);

  const coalition = useMemo(() => coalitionAt(byPercent, threshold), [byPercent, threshold]);
  const segments = useMemo(() => buildSegments(topK, coalition), [topK, coalition]);

  // Cumulative start offset per drawn arc (the muted remainder is skipped; the
  // background track circle shows through instead).
  let start = 0;
  const arcs = segments
    .filter((s) => s.kind !== 'remainder')
    .map((s, i) => {
      const dash = (s.pct / 100) * C;
      const offset = -(start / 100) * C;
      start += s.pct;
      return { dash, offset, tone: toneFor(s.kind, i) };
    });

  // Threshold tick: a short radial line at the selected percent (top is 0%).
  const tickRad = ((threshold / 100) * 360 - 90) * (Math.PI / 180);
  const inner = R - STROKE / 2 - 3;
  const outer = R + STROKE / 2 + 3;
  const tx1 = 100 + inner * Math.cos(tickRad);
  const ty1 = 100 + inner * Math.sin(tickRad);
  const tx2 = 100 + outer * Math.cos(tickRad);
  const ty2 = 100 + outer * Math.sin(tickRad);

  return (
    <section className="drep-conc" aria-labelledby="drep-conc-title">
      <h2 id="drep-conc-title" className="drep-conc__title">Voting power concentration</h2>
      <p className="drep-conc__summary">
        {summarySentence(coalition.count, threshold)} of {totalLabel} across {drepCount.toLocaleString('en-US')} DReps.
      </p>

      <div className="drep-conc__chart">
        <svg viewBox="0 0 200 200" width="200" height="200" aria-hidden="true">
          <circle cx="100" cy="100" r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} opacity="0.5" />
          <g transform="rotate(-90 100 100)">
            {arcs.map((a, i) => (
              <circle
                key={i}
                cx="100"
                cy="100"
                r={R}
                fill="none"
                stroke={a.tone}
                strokeWidth={STROKE}
                strokeDasharray={`${a.dash} ${C - a.dash}`}
                strokeDashoffset={a.offset}
              />
            ))}
          </g>
          <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} stroke="var(--fg)" strokeWidth="2" />
        </svg>
        <div className="drep-conc__center">
          <span className="drep-conc__count">{coalition.count.toLocaleString('en-US')}</span>
          <span className="drep-conc__count-label">DReps = {threshold}%</span>
        </div>
      </div>

      <div className="drep-conc__controls">
        <label htmlFor="drep-conc-slider" className="drep-conc__slider-label">Threshold: {threshold}%</label>
        <input
          id="drep-conc-slider"
          type="range"
          min={SLIDER_MIN}
          max={SLIDER_MAX}
          step={1}
          value={threshold}
          list="drep-conc-markers"
          onChange={(e) => setThreshold(snapThreshold(Number(e.target.value), markersPct))}
        />
        <datalist id="drep-conc-markers">
          {markersPct.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="drep-conc__markers">
          {markersPct.map((m) => (
            <button
              key={m}
              type="button"
              className="drep-conc__marker"
              aria-pressed={threshold === m}
              onClick={() => setThreshold(m)}
            >
              {m}%
            </button>
          ))}
        </div>
      </div>

      {thresholdsAsOf && <p className="drep-conc__asof">Thresholds as of {thresholdsAsOf}.</p>}

      <ol className="drep-conc__legend">
        {topK.map((t, i) => (
          <li key={t.drepId} className="drep-conc__legend-item">
            <span className="drep-conc__swatch" style={{ background: topTone(i) }} aria-hidden="true" />
            <a href={`/dreps/${t.drepId}`} className="drep-conc__legend-name">{t.name ?? t.drepId}</a>
            <span className="drep-conc__legend-pct">{t.pct}%</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

- [ ] **Step 2: Append the styles**

Append this block to the end of `src/styles/global.css`:

```css
/* DRep voting-power concentration donut (/dreps). */
.drep-conc { margin: 1.5rem 0 2rem; padding: 1.25rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.drep-conc__title { margin: 0 0 0.25rem; font-size: 1.05rem; }
.drep-conc__summary { margin: 0 0 1rem; color: var(--muted); font-size: 0.9rem; }
.drep-conc__chart { position: relative; width: 200px; height: 200px; margin: 0 auto; }
.drep-conc__center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.drep-conc__count { font-size: 2rem; font-weight: 700; line-height: 1; }
.drep-conc__count-label { font-size: 0.8rem; color: var(--muted); }
.drep-conc__controls { display: flex; flex-direction: column; gap: 0.4rem; max-width: 360px; margin: 1rem auto 0; }
.drep-conc__controls input[type='range'] { width: 100%; accent-color: var(--accent); }
.drep-conc__slider-label { font-size: 0.85rem; color: var(--muted); text-align: center; }
.drep-conc__markers { display: flex; gap: 0.5rem; justify-content: center; }
.drep-conc__marker { font-size: 0.8rem; padding: 0.2rem 0.6rem; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--muted); cursor: pointer; }
.drep-conc__marker[aria-pressed='true'] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.drep-conc__asof { text-align: center; color: var(--muted); font-size: 0.75rem; margin: 0.5rem 0 0; }
.drep-conc__legend { list-style: none; padding: 0; margin: 1rem auto 0; max-width: 420px; display: flex; flex-direction: column; gap: 0.3rem; }
.drep-conc__legend-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
.drep-conc__swatch { width: 0.8rem; height: 0.8rem; border-radius: 3px; flex-shrink: 0; }
.drep-conc__legend-name { text-decoration: none; color: var(--fg); }
.drep-conc__legend-name:hover { text-decoration: underline; }
.drep-conc__legend-pct { margin-left: auto; color: var(--muted); }
```

- [ ] **Step 3: Verify it type-checks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/DrepConcentration.tsx src/styles/global.css
git commit -m "feat: add DRep concentration donut island and styles"
```

---

## Task 10: /dreps page integration

**Files:**
- Modify: `src/pages/dreps/index.astro` (frontmatter imports + computation, body markup)

- [ ] **Step 1: Add imports and computation to the frontmatter**

In `src/pages/dreps/index.astro`, add to the imports (after the existing `import ... from '@/lib/forum/view.js'` line):

```astro
import DrepConcentration from '@/components/DrepConcentration.tsx';
import { listDreps, listDrepsForConcentration } from '@/lib/db/dreps.js';
import { computeConcentration } from '@/lib/dreps/concentration.js';
import { getDrepThresholds, DEFAULT_MARKERS } from '@/lib/dreps/thresholds.js';
```

(Replace the existing `import { listDreps } from '@/lib/db/dreps.js';` line; it is merged into the import above. Keep the existing `AuthorIdentity`, `Layout`, and `cloudflare:workers` imports.)

Then, after the existing `const dreps = db ? await listDreps(...) : [];` block and before the `Astro.response.headers.set(...)` line, add:

```astro
// Voting power concentration: all active, non-special DReps as BigInt powers.
const concentrationRows = db ? await listDrepsForConcentration(db) : [];
const concentration = computeConcentration(
  concentrationRows.map((r) => ({ drepId: r.drepId, name: r.name, power: BigInt(r.votingPower ?? '0') })),
);
const storedThresholds = db ? await getDrepThresholds(db) : null;
const markersPct = (storedThresholds?.markers ?? DEFAULT_MARKERS).map((m) => Math.round(m * 100));
const defaultThresholdPct = markersPct.includes(67) ? 67 : (markersPct[Math.floor(markersPct.length / 2)] ?? 67);
const thresholdsAsOf = storedThresholds ? new Date(storedThresholds.asOf).toISOString().slice(0, 10) : null;
const defaultCoalition = concentration.byPercent[defaultThresholdPct] ?? { count: 0, cumPct: 0 };
```

- [ ] **Step 2: Mount the island in the body**

In `src/pages/dreps/index.astro`, immediately after the `<h1>DReps</h1>` line, insert:

```astro
  {concentration.drepCount > 0 && (
    <>
      <noscript>
        <p>
          Top {defaultCoalition.count} DReps hold {defaultThresholdPct}% of active DRep voting power{thresholdsAsOf ? `, as of ${thresholdsAsOf}` : ''}.
        </p>
      </noscript>
      <DrepConcentration
        client:visible
        topK={concentration.topK}
        byPercent={concentration.byPercent}
        drepCount={concentration.drepCount}
        totalLabel={concentration.totalLabel}
        markersPct={markersPct}
        defaultThresholdPct={defaultThresholdPct}
        thresholdsAsOf={thresholdsAsOf}
      />
    </>
  )}
```

- [ ] **Step 3: Verify type-check and build**

Run: `npm run typecheck && npm run build`
Expected: PASS (Astro check clean; the build produces `dist/` without errors).

- [ ] **Step 4: Commit**

```bash
git add src/pages/dreps/index.astro
git commit -m "feat: show voting-power concentration donut on the DReps page"
```

---

## Task 11: Full verification and PR

**Files:** none (verification and PR only).

- [ ] **Step 1: Run the full test suite, lint, typecheck, build**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: all PASS. Do NOT run `biome format` across the repo (the repo is not format-clean; only `biome lint` is the gate).

- [ ] **Step 2: Manual smoke check (optional but recommended)**

Run the preprod cron worker once to populate thresholds locally, then the app:

Run: `npm run sync:dev` (in one shell, trigger the drep-sync cron via the printed `/__scheduled` URL with the `0 */6 * * *` cron), then `npm run dev` and open `/dreps`.
Expected: the donut renders, the slider snaps to 60/67/75, the center shows "N DReps = T%", and the directory below no longer lists the always-abstain pseudo-DRep. If thresholds were not synced, the donut still renders with the fallback markers and no "as of" line.

- [ ] **Step 3: Push the branch and open the PR**

```bash
git push -u origin feat/dreps-front-end
gh pr create --title "feat: DReps in navbar, Help in footer, voting-power concentration donut" --body "$(cat <<'EOF'
- Move the DReps link into the top navbar and Help down into the footer (before Privacy)
- Add an interactive voting-power concentration donut to /dreps: a slider (snapping to the live 60/67/75% DRep thresholds) shows the smallest coalition of DReps whose combined power crosses the selected threshold
- Pull the DRep voting thresholds live from Koios epoch_params during the drep-sync cron and store them in a new generic app_meta table
- Exclude the predefined pseudo-DReps (always-abstain, always-no-confidence) from the donut denominator and from the directory listing
- Concentration math uses BigInt (lovelace sums exceed Number.MAX_SAFE_INTEGER); pure logic is unit-tested, the React island is thin
EOF
)"
```

Expected: the PR is created. STOP here and return the PR URL; do not merge.

---

## Spec coverage check

- Navbar + footer: Task 1.
- app_meta + live thresholds (Koios epoch_params, stored, with as-of): Tasks 2, 3, 4, 5.
- Exclude pseudo-DReps from donut and directory: Task 6.
- Concentration computation (BigInt, compact payload): Task 7.
- Donut island with slider snapping to live thresholds, center "N DReps = T%", legend, no-JS fallback: Tasks 8, 9, 10.
- Edge cases (empty set, null power, thresholds not synced, division by zero): covered in Tasks 7 (computation guards) and 10 (drepCount gate, fallback markers).
- Testing: node-pool unit tests (concentration, concentrationView, epochParams) and workers-pool D1 tests (appMeta, thresholds, dreps exclusion/query).

PR 2 (self-hosted R2 avatars) is intentionally not in this plan; it gets its own cycle.
