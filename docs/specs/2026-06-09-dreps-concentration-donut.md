# Design: /dreps front end (navigation + voting power concentration donut)

Date: 2026-06-09
Status: Approved, ready for implementation
Scope: PR 1 of 2. Self hosted DRep avatars (R2) are a separate follow up (see "Out of scope").

## Summary

Three changes to the public DReps surface:

1. Move the `DReps` link into the top navbar and move `Help` down into the footer.
2. Add an interactive "voting power concentration" donut to `/dreps` that shows
   the smallest coalition of DReps whose combined voting power crosses a chosen
   ratification threshold (default 67%), with a slider that snaps to the live
   on chain DRep thresholds.
3. Exclude the protocol's pseudo DReps (always abstain, always no confidence)
   from both the donut denominator and the directory listing, so the figures
   reflect real voters.

## Goals

- Make DRep voting power concentration legible at a glance: "N DReps already
  hold 67% of active DRep voting power."
- Keep it lean and cheap: no per request third party calls, no large client
  payloads, edge cached like the rest of the synced surface.
- Thresholds are live (read from Koios epoch params), not hardcoded, so they
  stay correct if governance changes them.

## Non goals

- No change to how avatars are fetched or served (that is PR 2).
- No new cron cadence; the threshold fetch piggybacks on the existing drep sync.
- No SPO thresholds in this view; the donut is about DRep voting power only.

## A. Navigation

File: `src/layouts/Layout.astro`.

- `navLinks` becomes: `Governance Actions`, `Discussions`, `DReps`
  (href `/dreps`). `Help` is removed from `navLinks`.
- Footer links become, in order: `Help` (`/help`), `Privacy`, `Imprint`,
  GitHub icon. `Help` sits before `Privacy`.
- The mobile menu uses the same `navLinks`, so it updates automatically.

## B. Data and sync

### B1. Generic app_meta table

Migration `migrations/0016_app_meta.sql`:

```sql
CREATE TABLE app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

A small key/value store in D1, reusable beyond this feature. Accessor in
`src/lib/db/appMeta.ts` with `getAppMeta(db, key)` and
`setAppMeta(db, key, value, updatedAt)`, both parameterized.

### B2. Live DRep thresholds

- Koios client (`src/lib/koios/client.ts`) gains `epochParams()`: GET
  `/epoch_params` (current epoch), zod validated to the `dvt_*` DRep threshold
  fields we care about:
  `dvt_motion_no_confidence`, `dvt_committee_normal`,
  `dvt_committee_no_confidence`, `dvt_update_to_constitution`,
  `dvt_hard_fork_initiation`, `dvt_p_p_network_group`,
  `dvt_p_p_economic_group`, `dvt_p_p_technical_group`,
  `dvt_p_p_gov_group`, `dvt_treasury_withdrawal`.
- The drep sync (`src/lib/dreps/sync.ts`) fetches epoch params once at the end
  of a run and writes the threshold map as JSON to `app_meta` under key
  `drep_vote_thresholds`, with `updated_at = now`. One extra Koios call per
  4 to 6 hour run. Failure here is non fatal: it logs and leaves the previous
  stored value in place (the rest of the sync already succeeded).
- The stored shape:

```json
{
  "thresholds": { "noConfidence": 0.67, "committeeNormal": 0.67, "... ": "..." },
  "markers": [0.60, 0.67, 0.75]
}
```

  `markers` is the sorted set of distinct DRep threshold values, derived once at
  write time so the page and island do not have to recompute it.

### B3. Special DReps

`src/lib/dreps/special.ts` exports
`SPECIAL_DREP_IDS = ['drep_always_abstain', 'drep_always_no_confidence']`
(and any bech32 equivalents Koios returns). These ids are excluded:

- from `listDreps` in `src/lib/db/dreps.ts` (so the directory does not show the
  pseudo DReps at the top of the power sorted list), and
- from the concentration aggregate query.

## C. Concentration computation

File: `src/lib/dreps/concentration.ts`, a pure module with unit tests.

Input: an array of real, active DReps sorted descending by numeric voting power,
each `{ drepId, name, power }` (power as a number in lovelace).

Output (kept small for the client payload):

```ts
interface Concentration {
  total: number;            // sum of all included voting power
  drepCount: number;        // number of included DReps
  topK: Array<{ drepId: string; name: string | null; power: number; pct: number }>;
  // coalitionByPercent[p] = minimum number of DReps whose cumulative power
  // reaches p percent of total, for p in 0..100. coalitionByPercent[0] = 0.
  coalitionByPercent: number[];
}
```

- `topK` is the largest ~12 DReps, used for the legend and the individually
  colored arc segments.
- `coalitionByPercent` is a 101 element lookup. The slider reads
  `coalitionByPercent[T]` to get N for any integer threshold T without shipping
  every DRep power to the client.
- Guards: empty input returns a zeroed result; `power` null or NaN counts as 0;
  `total <= 0` short circuits (the page renders the empty state).

The page query (in `src/pages/dreps/index.astro`, or a helper in
`src/lib/db/dreps.ts`) selects `drep_id, name, voting_power` for active, non
special DReps ordered by `CAST(voting_power AS INTEGER) DESC`. About 2000 single
column rows, one cheap scan, and the page is edge cached so only cold renders
pay it.

## D. UI: donut island

File: `src/components/DrepConcentration.tsx`, a React island mounted on
`/dreps` with `client:visible` (matches the existing island pattern such as
`Composer.tsx`).

Props (compact, server computed):

```ts
interface Props {
  total: number;
  drepCount: number;
  topK: Concentration['topK'];
  coalitionByPercent: number[];
  markers: number[];          // e.g. [0.60, 0.67, 0.75]
  defaultThreshold: number;   // 0.67
  thresholdsAsOf: number | null; // app_meta.updated_at, or null on fallback
}
```

Render:

- An SVG donut whose full ring is 100% of included voting power. The highlighted
  arc is the minimum coalition that crosses the selected threshold T; its real
  size is the coalition's cumulative power (>= T). A thin tick marks exactly T on
  the ring. The top few DReps render as distinct segments inside the arc; the
  rest of the coalition is one shade; the remainder of the ring is muted.
- Center label: a large `N` over `DReps = {T as percent}`.
- A slider below the donut sets T. It snaps to the values in `markers` (with
  visible detents) but can also move freely between them. Default position is
  `defaultThreshold`.
- A legend lists the `topK` DReps with their share, and a line
  "Thresholds as of {date}" when `thresholdsAsOf` is set.

Accessibility and no JS:

- The page renders a static summary sentence server side, for example
  "Top {N} DReps hold 67% of active DRep voting power, as of {date}", computed
  from `coalitionByPercent[67]`. The island enhances this; without JS the
  sentence and the directory still work.
- The slider is a native range input with an accessible label; the donut is
  `aria-hidden` with the summary providing the text alternative.

Fallback when `app_meta` has no thresholds yet (first deploy before the cron
runs): use `markers = [0.60, 0.67, 0.75]` and `defaultThreshold = 0.67`, omit
the "as of" line.

## Data flow

```
drep-sync cron ──► dreps table (voting power, names)
               └─► app_meta[drep_vote_thresholds] (live dvt_* + markers)

/dreps page (SSR, edge cached)
  ├─ query active non special DReps  ─► concentration.ts ─► { total, topK, coalitionByPercent }
  ├─ read app_meta[drep_vote_thresholds] ─► markers, asOf (or fallback)
  └─ pass compact props ─► <DrepConcentration> island ─► donut + slider
```

## Edge cases

- Empty or tiny DRep set: render a neutral placeholder, no donut.
- All powers zero or equal: guard division by zero; donut shows a single arc.
- `voting_power` null: treated as 0, excluded from `topK`.
- Thresholds not yet synced: fallback constants, no "as of".
- Special DReps present in the table: filtered out in the query layer.

## Testing

- `concentration.test.ts`: empty input, single DRep, uniform distribution,
  skewed distribution (one DRep over the threshold), null powers, and that
  `coalitionByPercent` is monotonic and `[100]` equals `drepCount`.
- `appMeta` get/set round trip (workers test).
- `epochParams()` zod parse against a representative Koios payload.
- Sync test: a run writes `app_meta[drep_vote_thresholds]`; a Koios epoch params
  failure does not abort the run and leaves the prior value.
- `listDreps` excludes special ids.

## Out of scope (PR 2, separate cycle)

Self hosted DRep avatars: the drep sync downloads each CIP-119 image once
(resolving ipfs:// to the gateway), validates and stores it in R2, and the
avatar route serves from R2 instead of proxying the upstream per request. This
removes the third party request on cache miss (privacy) and the upstream round
trip (performance). It needs an R2 binding, a serve route change, and a schema
column for the stored key, so it gets its own spec, plan, and PR.
