# Activity feed redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the "Latest activity" feed into structured rows (icon tile, content column, right-aligned time) and give the /discussions copy type tabs (All / Governance actions / Comments) with server-side filtering and pagination.

**Architecture:** A new DB reader `getActivityPage({filter,limit,offset})` joins topics (so deleted ones are excluded in SQL and the count is accurate) and filters by activity type. `loadActivityFeed` is refactored to use it and return `{events,total}`. A reworked `ActivityRow` and a new `ActivityFeed` section wrapper render both surfaces; the homepage uses the compact variant, /discussions the full variant.

**Tech Stack:** Astro 6 (SSR, `prerender = false`), Cloudflare Workers + D1, Vitest (`vitest.config.ts` for node unit tests, `vitest.workers.config.ts` for real-D1 workers tests).

---

## File structure

- `src/lib/forum/activityFeed.ts` (modify): add `ActivityFilter`, `parseActivityFilter`, `ACTIVITY_TABS`; refactor `loadActivityFeed` signature and return type.
- `src/lib/db/activity.ts` (modify): add `getActivityPage`; remove the now-unused `getRecentActivity`.
- `src/components/ActivityRow.astro` (rewrite): three-column row.
- `src/components/ActivityFeed.astro` (create): section wrapper (header, tabs, list, pagination, footer).
- `src/pages/index.astro` (modify): homepage uses `ActivityFeed` compact variant.
- `src/pages/discussions.astro` (modify): right column uses `ActivityFeed` full variant with tabs + pagination.
- Tests: `src/lib/forum/activityFeed.test.ts` (new unit), `src/lib/db/activity.workers.test.ts` (modify), `src/lib/forum/activityFeed.workers.test.ts` (modify).

---

## Task 1: Filter type, parser, and tab list

**Files:**
- Modify: `src/lib/forum/activityFeed.ts`
- Test: `src/lib/forum/activityFeed.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/forum/activityFeed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseActivityFilter, ACTIVITY_TABS } from './activityFeed.js';

describe('parseActivityFilter', () => {
  it('defaults to all and passes valid values through', () => {
    expect(parseActivityFilter(null)).toBe('all');
    expect(parseActivityFilter('garbage')).toBe('all');
    expect(parseActivityFilter('governance')).toBe('governance');
    expect(parseActivityFilter('comments')).toBe('comments');
    expect(parseActivityFilter('all')).toBe('all');
  });
});

describe('ACTIVITY_TABS', () => {
  it('is ordered all, governance, comments', () => {
    expect(ACTIVITY_TABS.map((t) => t.filter)).toEqual(['all', 'governance', 'comments']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.ts src/lib/forum/activityFeed.test.ts`
Expected: FAIL ("parseActivityFilter is not exported" / undefined).

- [ ] **Step 3: Add the type, parser, and tabs to `activityFeed.ts`**

At the top of `src/lib/forum/activityFeed.ts`, after the existing imports, add:

```ts
export type ActivityFilter = 'all' | 'governance' | 'comments';

// Tab order + labels for the /discussions feed; the single source of both.
export const ACTIVITY_TABS: readonly { filter: ActivityFilter; label: string }[] = [
  { filter: 'all', label: 'All' },
  { filter: 'governance', label: 'Governance actions' },
  { filter: 'comments', label: 'Comments' },
];

const VALID_FILTERS = new Set<string>(ACTIVITY_TABS.map((t) => t.filter));

/** Parses the ?filter= param; defaults to 'all' for anything unrecognized. */
export function parseActivityFilter(value: string | null): ActivityFilter {
  return value && VALID_FILTERS.has(value) ? (value as ActivityFilter) : 'all';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.config.ts src/lib/forum/activityFeed.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/forum/activityFeed.ts src/lib/forum/activityFeed.test.ts
git commit -m "feat: add activity feed type filter parser and tab list"
```

---

## Task 2: `getActivityPage` DB reader

**Files:**
- Modify: `src/lib/db/activity.ts`
- Test: `src/lib/db/activity.workers.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/db/activity.workers.test.ts` (a new `describe`; keep existing imports, add `getActivityPage` and `activityInsert` to the import from `./activity.js` if not present). This seeds two topics (one governance, one forum) plus a deleted topic, inserts one event of each type, and asserts the filters:

```ts
describe('getActivityPage', () => {
  async function seedTopic(id: string, source: 'user' | 'governance', deleted = 0) {
    await env.DB.prepare(
      "INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted) VALUES (?, ?, 'a', ?, ?, ?, 1, 0, 0, ?)",
    )
      .bind(id, source === 'governance' ? 'governance-actions' : 'general', source, `T-${id}`, `t-${id}`, deleted)
      .run();
  }

  it('filters by type, excludes deleted topics, and returns a total', async () => {
    await seedTopic('gov1', 'governance');
    await seedTopic('forum1', 'user');
    await seedTopic('del1', 'user', 1);

    await env.DB.batch([
      activityInsert(env.DB, { type: 'gov_created', topicId: 'gov1', createdAt: 100 }),
      activityInsert(env.DB, { type: 'gov_status', topicId: 'gov1', payload: { from: 'active', to: 'enacted' }, createdAt: 200 }),
      activityInsert(env.DB, { type: 'reply_created', topicId: 'forum1', actorId: 'a', refPostId: 'p1', createdAt: 300 }),
      activityInsert(env.DB, { type: 'topic_created', topicId: 'forum1', actorId: 'a', createdAt: 400 }),
      activityInsert(env.DB, { type: 'reply_created', topicId: 'del1', actorId: 'a', createdAt: 500 }),
    ]);

    const all = await getActivityPage(env.DB, { filter: 'all', limit: 50, offset: 0 });
    // del1's event is excluded (deleted topic); 4 remain, newest first.
    expect(all.total).toBe(4);
    expect(all.rows.map((r) => r.type)).toEqual(['topic_created', 'reply_created', 'gov_status', 'gov_created']);

    const gov = await getActivityPage(env.DB, { filter: 'governance', limit: 50, offset: 0 });
    expect(gov.total).toBe(2);
    expect(gov.rows.every((r) => r.type === 'gov_created' || r.type === 'gov_status')).toBe(true);

    const comments = await getActivityPage(env.DB, { filter: 'comments', limit: 50, offset: 0 });
    expect(comments.total).toBe(1);
    expect(comments.rows[0].type).toBe('reply_created');
    expect(comments.rows[0].topic_id).toBe('forum1');
  });

  it('paginates with limit and offset', async () => {
    await seedTopic('p', 'user');
    await env.DB.batch([
      activityInsert(env.DB, { type: 'reply_created', topicId: 'p', actorId: 'a', createdAt: 1 }),
      activityInsert(env.DB, { type: 'reply_created', topicId: 'p', actorId: 'a', createdAt: 2 }),
      activityInsert(env.DB, { type: 'reply_created', topicId: 'p', actorId: 'a', createdAt: 3 }),
    ]);
    const page = await getActivityPage(env.DB, { filter: 'comments', limit: 2, offset: 0 });
    expect(page.rows.length).toBe(2);
    expect(page.total).toBe(3);
    const page2 = await getActivityPage(env.DB, { filter: 'comments', limit: 2, offset: 2 });
    expect(page2.rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/activity.workers.test.ts -t getActivityPage`
Expected: FAIL ("getActivityPage is not a function").

- [ ] **Step 3: Implement `getActivityPage` in `activity.ts`**

Add the `sqlPlaceholders` import at the top of `src/lib/db/activity.ts`:

```ts
import { sqlPlaceholders } from './sql.js';
```

Then add, after `getRecentActivity` (which Task 3 removes):

```ts
// Activity types each feed filter includes. 'all' is handled by skipping the
// type clause entirely. Constant per filter (never user input).
const FILTER_TYPES: Record<'governance' | 'comments', ActivityKind[]> = {
  governance: ['gov_created', 'gov_status'],
  comments: ['reply_created'],
};

/**
 * One page of activity events for a feed filter, newest first, joined to topics
 * so deleted-topic events are excluded in SQL (the count then matches the rows).
 * 'all' applies no type clause; 'governance'/'comments' restrict by type. Returns
 * the page rows plus the full matching count for pagination. limit clamped to
 * [1,50]; offset >= 0. The id DESC tiebreaker keeps equal-created_at order stable.
 */
export async function getActivityPage(
  db: D1Database,
  opts: { filter: 'all' | 'governance' | 'comments'; limit: number; offset: number },
): Promise<{ rows: ActivityRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const offset = Math.max(opts.offset, 0);

  const types = opts.filter === 'all' ? [] : FILTER_TYPES[opts.filter];
  const typeClause = types.length ? ` AND a.type IN (${sqlPlaceholders(types)})` : '';
  const base = `FROM activity a JOIN topics t ON t.id = a.topic_id WHERE t.deleted = 0${typeClause}`;

  const [pageRes, countRow] = await Promise.all([
    db
      .prepare(`SELECT a.* ${base} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
      .bind(...types, limit, offset)
      .all<ActivityRow>(),
    db.prepare(`SELECT COUNT(*) AS n ${base}`).bind(...types).first<{ n: number }>(),
  ]);

  return { rows: pageRes.results ?? [], total: countRow?.n ?? 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/activity.workers.test.ts -t getActivityPage`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/activity.ts src/lib/db/activity.workers.test.ts
git commit -m "feat: add paginated, type-filtered activity reader"
```

---

## Task 3: Refactor `loadActivityFeed` to filter + paginate + return total

**Files:**
- Modify: `src/lib/forum/activityFeed.ts`
- Modify: `src/lib/db/activity.ts` (remove `getRecentActivity`)
- Test: `src/lib/forum/activityFeed.workers.test.ts`, `src/lib/db/activity.workers.test.ts`

- [ ] **Step 1: Update the loader test to the new shape**

In `src/lib/forum/activityFeed.workers.test.ts`, the existing tests call `loadActivityFeed(db, { limit })` and use the returned array. Update each call to destructure `{ events }` and add a filter assertion. Replace the existing assertions that read the array directly, e.g. a call like `const feed = await loadActivityFeed(db, { limit: 20 });` becomes:

```ts
const { events, total } = await loadActivityFeed(db, { limit: 20 });
expect(typeof total).toBe('number');
```

Add one new test (governance filter excludes comments):

```ts
it('filter governance returns only governance events', async () => {
  // (reuse the file's existing seed helpers to create one gov_created and one
  //  reply_created event, then:)
  const { events } = await loadActivityFeed(db(), { filter: 'governance', limit: 20 });
  expect(events.every((e) => e.kind === 'gov_created' || e.kind === 'gov_status')).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/forum/activityFeed.workers.test.ts`
Expected: FAIL (return value is now an object, `.map`/array assertions break; `filter` not supported).

- [ ] **Step 3: Refactor `loadActivityFeed`**

In `src/lib/forum/activityFeed.ts`, change the import on line 8 from `getRecentActivity` to `getActivityPage`:

```ts
import { getActivityPage } from '../db/activity.js';
import type { ActivityKind } from '../db/activity.js';
```

Replace the whole `loadActivityFeed` function (lines 44-97) with:

```ts
/**
 * Loads one page of activity events as ready view models, newest first, for the
 * given type filter. getActivityPage already excludes deleted-topic events in
 * SQL, so the returned total matches the rows. Hydration is batched (topics,
 * authors, governance). Default limit 20, capped at 50.
 */
export async function loadActivityFeed(
  db: D1Database,
  opts: { filter?: ActivityFilter; limit: number; offset?: number },
): Promise<{ events: ActivityEvent[]; total: number }> {
  const filter = opts.filter ?? 'all';
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const offset = Math.max(opts.offset ?? 0, 0);

  const { rows, total } = await getActivityPage(db, { filter, limit, offset });
  if (rows.length === 0) return { events: [], total };

  const topicIds = [...new Set(rows.map((r) => r.topic_id))];
  const topicsById = await getTopicsByIds(db, topicIds);

  // Defensive: a topic deleted between the page query and this read would still
  // be returned by getTopicsByIds; drop those so removed content never renders.
  const live = rows.filter((r) => {
    const t = topicsById.get(r.topic_id);
    return t && !t.deleted;
  });

  const govTopicIds = live
    .filter((r) => topicsById.get(r.topic_id)?.source === 'governance')
    .map((r) => r.topic_id);

  const [identities, govByTopic] = await Promise.all([
    loadAuthorIdentities(db, live.map((r) => r.actor_id)),
    govTopicIds.length ? getGovernanceActionsByTopicIds(db, govTopicIds) : Promise.resolve(new Map()),
  ]);

  const events = live.map((r) => {
    const t = topicsById.get(r.topic_id)!;
    const gov = govByTopic.get(r.topic_id);
    const transition = r.type === 'gov_status' ? parseTransition(r.payload) : null;
    return {
      kind: r.type,
      createdAt: r.created_at,
      actor: r.actor_id ? identities.describe(r.actor_id) : null,
      topic: {
        title: t.title,
        slug: t.slug,
        categoryName: getCategory(t.category_slug)?.name ?? t.category_slug,
        isGovernance: t.source === 'governance',
      },
      governanceStatus: gov?.status ?? transition?.to ?? null,
      statusTransition: transition,
      refPostId: r.ref_post_id,
    };
  });

  return { events, total };
}
```

Note `ActivityFilter` is defined in this same file (Task 1), so no import is needed for it.

- [ ] **Step 4: Remove the now-unused `getRecentActivity`**

In `src/lib/db/activity.ts`, delete the `getRecentActivity` function (the `export async function getRecentActivity(...) { ... }` block) and its doc comment. In `src/lib/db/activity.workers.test.ts`, delete the `describe('getRecentActivity', ...)` block and drop `getRecentActivity` from the import.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/forum/activityFeed.workers.test.ts src/lib/db/activity.workers.test.ts`
Expected: PASS (no reference to `getRecentActivity` remains).

- [ ] **Step 6: Commit**

```bash
git add src/lib/forum/activityFeed.ts src/lib/db/activity.ts src/lib/forum/activityFeed.workers.test.ts src/lib/db/activity.workers.test.ts
git commit -m "refactor: loadActivityFeed filters, paginates, and returns a total"
```

---

## Task 4: Rework `ActivityRow.astro`

**Files:**
- Rewrite: `src/components/ActivityRow.astro`

No unit test (Astro component); verified by build (this task) and the browser (Task 8).

- [ ] **Step 1: Replace the component**

Overwrite `src/components/ActivityRow.astro` with:

```astro
---
// One activity feed line, three columns: a 40px icon tile (system house icon or
// the actor avatar), a content column (actor name + role badges + verb + linked
// title + inline status badge) that wraps within itself, and a right-aligned
// meta column (clock + relative time, plus an external-link on comment rows).
import type { ActivityEvent } from '@/lib/forum/activityFeed.js';
import Avatar from '@/components/Avatar.astro';
import { authorProfileHref } from '@/lib/forum/author.js';
import { formatRelativeTime } from '@/lib/forum/view.js';
import { statusBadge, govStatusVerb, isTerminalStatus, TONE_COLORS } from '@/lib/governance/view.js';

interface Props {
  event: ActivityEvent;
  now: number;
}

const { event, now } = Astro.props;

// Replies deep-link to the post; everything else links to the topic.
const href = event.refPostId ? `/t/${event.topic.slug}#post-${event.refPostId}` : `/t/${event.topic.slug}`;

const badge =
  (event.kind === 'gov_created' || event.kind === 'gov_status') && event.governanceStatus
    ? statusBadge(event.governanceStatus)
    : null;
// Terminal outcomes render as an outline pill; a live (active) one stays filled.
const badgeOutline = badge ? isTerminalStatus(event.governanceStatus as string) : false;

const actor = event.actor;
const profileHref = actor ? authorProfileHref(actor) : null;
const seed = actor?.identiconSeed ?? actor?.authorId ?? '';
const isComment = event.kind === 'reply_created';

const LINK = 'font-weight:500;text-decoration:none;color:var(--fg);';
---

<div class="act-row">
  {actor && !actor.isSystem ? (
    <Avatar seed={seed} imageHash={actor.imageHash} size={40} />
  ) : (
    <span class="act-tile" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18" /><path d="M5 21V10l7-5 7 5v11" /><path d="M9 21v-6h6v6" /></svg>
    </span>
  )}

  <div class="act-body">
    <span class="act-text">
      {actor && (
        <Fragment>
          {profileHref ? <a class="act-name" href={profileHref}>{actor.displayName}</a> : <span class="act-name">{actor.displayName}</span>}
          {(actor.badges ?? []).map((b) => <span class="act-role">{b}</span>)}
          {' '}
        </Fragment>
      )}
      {event.kind === 'topic_created' && (
        <Fragment>started <a href={href} style={LINK}>{event.topic.title}</a> <span style="color:var(--muted);">in {event.topic.categoryName}</span></Fragment>
      )}
      {event.kind === 'reply_created' && (
        event.topic.isGovernance
          ? <Fragment>commented on <a href={href} style={LINK}>{event.topic.title}</a></Fragment>
          : <Fragment>replied in <a href={href} style={LINK}>{event.topic.title}</a></Fragment>
      )}
      {event.kind === 'gov_created' && (
        <Fragment>New governance action: <a href={href} style={LINK}>{event.topic.title}</a></Fragment>
      )}
      {event.kind === 'gov_status' && (
        <Fragment><a href={href} style={LINK}>{event.topic.title}</a> {govStatusVerb(event.statusTransition?.to ?? '')}</Fragment>
      )}
      {badge && (
        <span class={`act-badge${badgeOutline ? ' act-badge--outline' : ''}`} style={`--badge:${TONE_COLORS[badge.tone]};`}>{badge.label}</span>
      )}
    </span>
  </div>

  <span class="act-meta">
    <span class="act-time">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
      {formatRelativeTime(event.createdAt, now)}
    </span>
    {isComment && (
      <a class="act-ext" href={href} aria-label="Open thread">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
      </a>
    )}
  </span>
</div>

<style>
  .act-row {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    padding: 0.875rem 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.9rem;
    line-height: 1.55;
  }
  /* System/governance icon tile: rounded square, faint accent. */
  .act-tile {
    display: inline-flex;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }
  .act-body { flex: 1; min-width: 0; }
  .act-text { color: var(--fg); }
  .act-name { font-weight: 600; color: var(--fg); text-decoration: none; }
  .act-name:hover { text-decoration: underline; }
  /* Role badge (DREP etc.): outline pill in accent, matching AuthorIdentity. */
  .act-role {
    margin-left: 0.3rem;
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
    border-radius: 999px;
    padding: 0.05rem 0.35rem;
    vertical-align: middle;
    white-space: nowrap;
  }
  /* Status badge: filled for active, outline for terminal outcomes. */
  .act-badge {
    margin-left: 0.35rem;
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #fff;
    background: var(--badge);
    border: 1px solid var(--badge);
    border-radius: 0.3rem;
    padding: 0.1rem 0.4rem;
    vertical-align: middle;
    white-space: nowrap;
  }
  .act-badge--outline { color: var(--badge); background: transparent; }
  /* Right meta: clock + time, optional external link. Never wraps. */
  .act-meta {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--muted);
    font-size: 0.8125rem;
    white-space: nowrap;
    padding-top: 0.1rem;
  }
  .act-time { display: inline-flex; align-items: center; gap: 0.3rem; }
  .act-ext { color: var(--muted); display: inline-flex; }
  .act-ext:hover { color: var(--fg); }
</style>
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: `0 errors`.

Run: `npm run build`
Expected: `Server built` / `Complete!` with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ActivityRow.astro
git commit -m "feat: restyle activity row into icon, content, and meta columns"
```

---

## Task 5: Create `ActivityFeed.astro` section wrapper

**Files:**
- Create: `src/components/ActivityFeed.astro`

- [ ] **Step 1: Create the component**

Create `src/components/ActivityFeed.astro`:

```astro
---
// One activity feed surface, shared by the homepage (compact: header + view-all
// link + rows) and /discussions (full: header + type tabs + rows + pagination +
// footer). Pure presentation; the page resolves events and passes them in.
import type { ActivityEvent } from '@/lib/forum/activityFeed.js';
import { ACTIVITY_TABS, type ActivityFilter } from '@/lib/forum/activityFeed.js';
import ActivityRow from '@/components/ActivityRow.astro';

interface Props {
  events: ActivityEvent[];
  now: number;
  title: string;
  subtitle: string;
  viewAllHref?: string;
  tabs?: { active: ActivityFilter; hrefFor: (f: ActivityFilter) => string };
  pagination?: { prevHref: string | null; nextHref: string | null };
  footer?: boolean;
}

const { events, now, title, subtitle, viewAllHref, tabs, pagination, footer } = Astro.props;
---

<section class="af" aria-label={title}>
  <header class="af-head">
    <div class="af-titles">
      <h2 class="af-title">
        <svg class="af-pulse" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
        {title}
      </h2>
      <p class="af-subtitle">{subtitle}</p>
    </div>
    {viewAllHref && (
      <a class="af-viewall" href={viewAllHref}>View all activity
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
      </a>
    )}
  </header>

  {tabs && (
    <nav class="af-tabs" aria-label="Filter activity">
      {ACTIVITY_TABS.map((t) => (
        <a class="af-tab" aria-current={t.filter === tabs.active ? 'true' : undefined} href={tabs.hrefFor(t.filter)}>{t.label}</a>
      ))}
    </nav>
  )}

  {events.length === 0 ? (
    <p class="af-empty">No recent activity yet.</p>
  ) : (
    <div class="af-list">
      {events.map((e) => <ActivityRow event={e} now={now} />)}
    </div>
  )}

  {pagination && (pagination.prevHref || pagination.nextHref) && (
    <nav class="af-pager" aria-label="Pagination">
      {pagination.prevHref ? <a href={pagination.prevHref}>Previous</a> : <span></span>}
      {pagination.nextHref ? <a href={pagination.nextHref}>Next</a> : <span></span>}
    </nav>
  )}

  {footer && (
    <p class="af-footer">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
      Updated just now
    </p>
  )}
</section>

<style>
  .af-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; }
  .af-title { display: flex; align-items: center; gap: 0.5rem; margin: 0; font-size: 1.25rem; }
  .af-pulse { color: var(--accent); flex-shrink: 0; }
  .af-subtitle { margin: 0.25rem 0 0; font-size: 0.875rem; color: var(--muted); }
  .af-viewall { display: inline-flex; align-items: center; gap: 0.25rem; flex-shrink: 0; font-size: 0.85rem; font-weight: 600; color: var(--accent); text-decoration: none; border: 1px solid var(--border); border-radius: 999px; padding: 0.4rem 0.75rem; }
  .af-viewall:hover { background: var(--surface-2); }

  .af-tabs { display: flex; flex-wrap: wrap; gap: 0.375rem; margin-bottom: 1rem; }
  .af-tab { display: inline-flex; align-items: center; padding: 0.375rem 0.75rem; font-size: 0.85rem; text-decoration: none; color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: 999px; transition: color 0.12s, background 0.12s, border-color 0.12s; }
  .af-tab:hover { color: var(--fg); }
  .af-tab[aria-current='true'] { color: var(--fg); background: var(--surface-2); border-color: var(--fg); font-weight: 600; }

  .af-empty { color: var(--muted); }
  .af-pager { display: flex; justify-content: space-between; margin-top: 1.25rem; font-size: 0.875rem; }
  .af-pager a { color: var(--accent); text-decoration: none; }
  .af-footer { display: flex; align-items: center; justify-content: center; gap: 0.4rem; margin: 1.25rem 0 0; font-size: 0.8125rem; color: var(--muted); }
</style>
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: `0 errors`.

- [ ] **Step 3: Commit**

```bash
git add src/components/ActivityFeed.astro
git commit -m "feat: add ActivityFeed section wrapper (header, tabs, pagination, footer)"
```

---

## Task 6: Wire the homepage to `ActivityFeed` (compact)

**Files:**
- Modify: `src/pages/index.astro`

- [ ] **Step 1: Update the loader call and the section**

In `src/pages/index.astro`:

1. Add the import near the other component imports (it already imports `ActivityRow`; add `ActivityFeed` and remove the now-unused `ActivityRow` import only if nothing else uses it on the page):

```ts
import ActivityFeed from '@/components/ActivityFeed.astro';
```

2. The page loads the feed inside a `Promise.all` assigning `feed` (around line 24: `loadActivityFeed(db, { limit: 6 })`). `loadActivityFeed` now returns `{ events, total }`. Change the destructuring so `feed` is the events array. Find where the Promise.all result is destructured and adjust, e.g. if it reads `const [..., feed] = await Promise.all([..., loadActivityFeed(db, { limit: 6 })])`, change that element to `loadActivityFeed(db, { limit: 6 }).then((r) => r.events)`. (Keeps `feed` an `ActivityEvent[]`.)

3. Replace the `<section aria-label="Latest activity"> ... </section>` block (lines 235-249) with:

```astro
      <ActivityFeed
        events={feed}
        now={now}
        title="Latest activity"
        subtitle="A summary of what's happening in governance."
        viewAllHref="/discussions"
      />
```

4. If the `section-label` / `view-all-row` / `view-all-link` styles in the page `<style>` are now unused (grep the file for each class), remove those rules. Leave any still used by other sections.

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: `0 errors`.

Run: `npm run build`
Expected: `Complete!` with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: use ActivityFeed for the homepage latest-activity section"
```

---

## Task 7: Wire /discussions to `ActivityFeed` (full, tabs + pagination)

**Files:**
- Modify: `src/pages/discussions.astro`

- [ ] **Step 1: Update the frontmatter**

In `src/pages/discussions.astro` frontmatter:

1. Replace the `ActivityRow` import with `ActivityFeed`, and import the filter helpers and `parsePage`/`pageToOffset`:

```ts
import ActivityFeed from '@/components/ActivityFeed.astro';
import { loadActivityFeed, parseActivityFilter, type ActivityFilter } from '@/lib/forum/activityFeed.js';
import { cacheControlFor, formatRelativeTime, parsePage, pageToOffset, SITE_ORIGIN } from '@/lib/forum/view.js';
```

2. After `const now = Date.now();`, add the filter + page parsing and feed call:

```ts
const PAGE_SIZE = 20;
const filter = parseActivityFilter(Astro.url.searchParams.get('filter'));
const page = parsePage(Astro.url.searchParams.get('page'));
const offset = pageToOffset(page, PAGE_SIZE);

const [stats, feed] = db
  ? await Promise.all([
      getCategoryStats(db),
      loadActivityFeed(db, { filter, limit: PAGE_SIZE, offset }),
    ])
  : [new Map<string, { topicCount: number; lastPostAt: number | null }>(), { events: [], total: 0 }];

// Tabs and pager keep the active filter; a filter change resets to page 1.
const tabHref = (f: ActivityFilter) => `/discussions?filter=${f}`;
const prevHref = page > 1 ? `/discussions?filter=${filter}&page=${page - 1}` : null;
const nextHref = offset + PAGE_SIZE < feed.total ? `/discussions?filter=${filter}&page=${page + 1}` : null;
```

Remove the old combined `const [stats, feed] = ...` block (lines 19-21) that this replaces.

- [ ] **Step 2: Replace the right column**

Replace the `<section aria-label="Latest activity"> ... </section>` block (lines 64-75) with:

```astro
    <ActivityFeed
      events={feed.events}
      now={now}
      title="Latest activity"
      subtitle="A summary of what's happening in governance."
      tabs={{ active: filter, hrefFor: tabHref }}
      pagination={{ prevHref, nextHref }}
      footer={true}
    />
```

Keep the `<section aria-label="Categories">` column and the `.discussions-grid` styles unchanged.

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: `0 errors`.

Run: `npm run build`
Expected: `Complete!`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/discussions.astro
git commit -m "feat: give /discussions activity type tabs and pagination"
```

---

## Task 8: Full verification and visual pass

**Files:** none (verification only)

- [ ] **Step 1: Run the whole gate**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: typecheck `0 errors`; lint clean; tests all pass; build `Complete!`.

- [ ] **Step 2: Visual check against the mockup**

Start the preview and view the feed:

```bash
npm run preview
```

Then in the browser (preview at http://localhost:8787):
- `/discussions`: confirm two columns (categories left, activity right); the rich rows (icon tile, name + DREP badge for commenters, inline status badge, right-aligned clock + time, external-link on comment rows); the type tabs switch the list (`?filter=governance`, `?filter=comments`) and paginate; the "Updated just now" footer shows.
- Force a long title (e.g. the "Hard Fork to Protocol Version 11" row) and confirm it wraps inside the content column, never under the icon, with the time staying top-right.
- `/` homepage: the compact feed with the same rows and a "View all activity" link to /discussions, no tabs/footer.
- Resize narrow (~380px) and confirm rows stay readable and the meta does not overlap the text.

Fix any spacing/wrap nits in `ActivityRow.astro` / `ActivityFeed.astro` and re-run Step 1. Commit fixes with `style: ...` or `fix: ...` as appropriate.

- [ ] **Step 3: Stop the preview**

```bash
lsof -ti:8787 | xargs kill 2>/dev/null; pkill -f "wrangler dev" 2>/dev/null
```

Then push the branch and open the PR per the usual workflow (wait for the user's go before merging).
