# Design: Activity feed redesign (rich rows, type tabs)

Date: 2026-06-20
Status: Approved, ready for implementation
Scope: Restyle the "Latest activity" feed and give the /discussions copy of it
type tabs (All / Governance actions / Comments) with server-side filtering and
pagination. The homepage keeps a compact copy in the same row style.

## Summary

The activity feed today is a plain list of one-line rows (`ActivityRow.astro`):
an icon or avatar, a verb, the linked title, an optional badge, and a relative
time, all in one wrapping flex row. Long titles wrap back under the icon and the
badge/time spill onto a new line at the left edge.

This redesign gives the feed the structured, scannable look from the mockup:

- A rounded icon tile (system house icon for governance, avatar for people),
  top-aligned.
- A content column with the actor's name + role badge (e.g. DREP), the verb, the
  linked title, and an inline status badge. Long titles wrap cleanly inside this
  column, never back under the icon.
- A right-aligned meta column: a clock icon + relative time, plus an external-link
  affordance on comment rows.
- On /discussions: a section header (title + one-line subtitle), type tabs, and a
  soft "Updated just now" footer. Tabs filter the whole activity history
  server-side and paginate.
- On the homepage: the same rows, compact, with a "View all activity" link to
  /discussions. No tabs or footer.

## Goals

- Match the mockup's row layout and fix the long-title wrap (the title and meta
  stay in their own columns).
- Let readers narrow the /discussions feed by type (All / Governance actions /
  Comments) across the full history, paginated, server-side.
- One `ActivityRow` shared by the homepage and /discussions; one `ActivityFeed`
  section wrapper so the two surfaces stay visually identical.
- Keep it lean and cheap: filtering and paging happen in the database (O(page
  size)), reusing the existing batched hydration.

## Non goals

- No `DRep activity` tab. DRep-authored comments still appear under "Comments"
  (with a DREP badge on the row); a dedicated actor-based tab is out of scope.
- No separate "Filter" dropdown from the mockup; the type tabs are the only filter.
- No new /activity route. /discussions IS the full activity view; the homepage
  links to it.
- No change to how events are produced (the `activity` table, emission, backfill
  are unchanged). This is a read/presentation change only.
- No change to the /discussions category navigation column; it stays to the left.

## A. Layout and placement

- **/discussions** stays two-column: category navigation on the left, the rich
  activity feed on the right (header + tabs + rows + pagination + footer). The
  right column is the `ActivityFeed` "full" variant.
- **Homepage** "Latest activity" section uses the same `ActivityFeed` in a
  "compact" variant: header with a "View all activity" link to /discussions, ~6
  rows, no tabs, no footer, no pagination.

## B. The activity row (`ActivityRow.astro`)

Three columns in one `display:flex; align-items:flex-start` row:

1. **Icon tile** (`flex-shrink:0`): a ~40px rounded square. For system/governance
   events (no actor) it holds the house icon on a faint `--accent` tint. For
   person events it renders the actor avatar (`AuthorIdentity`, circular as today).
2. **Content column** (`flex:1; min-width:0`): wraps within itself.
   - Person events: the actor name + role badges (DREP etc., already on
     `AuthorDescriptor.badges`) via `AuthorIdentity`, then the verb + linked title.
   - Governance events: the verb/sentence + linked title.
   - The governance **status badge** (ACTIVE filled, EXPIRED/RATIFIED outline)
     renders inline at the end of the text, from `statusBadge(governanceStatus)`.
   - Verb mapping is unchanged: `topic_created` -> "started <title> in <cat>";
     `reply_created` -> "commented on/replied in <title>"; `gov_created` -> "New
     governance action: <title>"; `gov_status` -> "<title> <govStatusVerb>".
3. **Right meta** (`flex-shrink:0`, right-aligned, `white-space:nowrap`): a clock
   icon + `formatRelativeTime`. On `reply_created` rows, an external-link icon
   linking to the post (`#post-<refPostId>`), matching the mockup's comment rows.

Wrapping: because the title lives in the flex:1 content column and the meta is its
own non-wrapping column, a long title wraps inside the content column and the time
stays top-right. This is the fix for the reported wrap bug.

## C. Type tabs and server-side filtering

Tabs map to a `?filter=` query param on /discussions:

| Tab               | filter        | activity rows matched                 |
| ----------------- | ------------- | ------------------------------------- |
| All               | `all`         | every type                            |
| Governance actions| `governance`  | `gov_created`, `gov_status`           |
| Comments          | `comments`    | `reply_created`                       |

- New `parseActivityFilter(value): ActivityFilter` in `activityFeed.ts` (defaults
  to `all`; mirrors `parseGovSort`). `ActivityFilter = 'all' | 'governance' | 'comments'`.
- New `ACTIVITY_TABS` array (`{ filter, label }`) drives the tab rendering and
  stays the single source of order/labels.
- New DB reader `getActivityPage(db, { filter, limit, offset })` in `activity.ts`:

  ```sql
  SELECT a.* FROM activity a
    JOIN topics t ON t.id = a.topic_id
   WHERE t.deleted = 0 [AND a.type IN (<filter types>)]
   ORDER BY a.created_at DESC
   LIMIT ? OFFSET ?
  ```

  plus a matching `COUNT(*)` for pagination total. The JOIN moves the
  deleted-topic filter into SQL so the count is accurate (today `loadActivityFeed`
  drops deleted topics after the fetch). The type list is a fixed switch over the
  `ActivityFilter` union (never user input), bound is not needed; interpolating the
  constant `IN (...)` keeps it injection-safe like `govPageOrderBy`. Limit clamped
  to [1,50], offset >= 0.

- `loadActivityFeed(db, { filter?, limit, offset? })` is refactored to call
  `getActivityPage` and return `{ events: ActivityEvent[]; total: number }`. The
  homepage calls it with `{ limit: 6 }` (filter defaults to all) and ignores
  `total`; /discussions passes `{ filter, limit: PAGE_SIZE, offset }` and uses
  `total` for prev/next.
- Pagination: prev/next links that preserve `filter`, like the governance category
  page's `pageHref`. `PAGE_SIZE` = 20.

Volume is low (hundreds of rows), so the existing `idx_activity_created` is enough;
no new index. If the feed grows, a `(type, created_at)` index is the follow-up.

## D. Section wrapper (`ActivityFeed.astro`)

A new component that renders one feed surface so the homepage and /discussions
match. Props:

- `events: ActivityEvent[]`, `now: number`.
- `title` + `subtitle` (header).
- `viewAllHref?: string` -> renders the "View all activity" link (homepage only).
- `tabs?: { active: ActivityFilter; hrefFor: (f: ActivityFilter) => string }` ->
  renders the type tabs (/discussions only).
- `pagination?: { prevHref: string | null; nextHref: string | null }`.
- `footer?: boolean` -> renders the soft "Updated just now" line.

It renders: header (pulse icon + title + subtitle + optional view-all), optional
tabs, the `ActivityRow` list (or an empty state), optional pagination, optional
footer. Tab styling reuses the pill pattern already in `c/[slug].astro` (`.ga-tabs`
/ `.ga-tab`); the shared rules move into this component's scoped styles.

## E. Header and footer

- Header: a small pulse/activity glyph + "Latest activity" + the subtitle "A
  summary of what's happening in governance." On the homepage the header also
  shows the "View all activity" link; on /discussions it does not (it is already
  the full view).
- Footer (/discussions only): a centered, muted "Updated just now". SSR renders
  fresh per request, but the page is edge-cached, so the copy stays deliberately
  soft (no precise timestamp). If we want accuracy later, show the newest event's
  age instead; out of scope now.

## F. Wiring

- `src/pages/discussions.astro`: keep the category nav column; replace the
  right-column feed with `ActivityFeed` (full variant). Read `filter` via
  `parseActivityFilter(Astro.url.searchParams.get('filter'))` and `page` via the
  existing `parsePage`; call `loadActivityFeed(db, { filter, limit: PAGE_SIZE, offset })`.
- `src/pages/index.astro`: replace the inline "Latest activity" section
  (`<section>` + `ActivityRow` loop + "View all discussions") with `ActivityFeed`
  (compact variant, `viewAllHref="/discussions"`, `loadActivityFeed(db, { limit: 6 })`).

## G. Testing

Vitest workers tests (real D1), following the existing `*.workers.test.ts` pattern:

- `getActivityPage`: `governance` returns only `gov_created`/`gov_status`;
  `comments` only `reply_created`; `all` returns every type; rows in deleted topics
  are excluded; `total` matches the filtered count; ordering is `created_at DESC`;
  limit/offset paginate.
- `parseActivityFilter`: defaults to `all`, passes valid values, rejects garbage.
- `loadActivityFeed`: hydrates title/author/governance, applies the filter, returns
  the right `total`.

Unit/relevant:
- `ACTIVITY_TABS` order is `['all','governance','comments']` (locks tab order).

The row and section components are verified in the browser (preview) against the
mockup, including the long-title wrap and the narrow two-column /discussions width.

## File touch list

- `src/lib/db/activity.ts` (add `getActivityPage` + count; keep `getRecentActivity`
  or express it via the new reader)
- `src/lib/forum/activityFeed.ts` (`ActivityFilter`, `parseActivityFilter`,
  `ACTIVITY_TABS`; refactor `loadActivityFeed` to `{ filter?, limit, offset? } ->
  { events, total }`)
- `src/components/ActivityRow.astro` (rework: icon tile, content column, right meta,
  inline status badge, clean wrapping)
- `src/components/ActivityFeed.astro` (new: header, tabs, list, pagination, footer)
- `src/pages/discussions.astro` (category nav + ActivityFeed full variant)
- `src/pages/index.astro` (ActivityFeed compact variant)
- tests alongside the above per the existing convention
