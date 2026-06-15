# Design: Discussions "latest activity" as a real event feed

Date: 2026-06-15
Status: Approved, ready for implementation
Scope: Replace the topic list shown under "Discussions / Latest activity" with a
forum style activity feed (one line per event). Homepage and `/discussions`.

## Summary

Today the "Latest activity" column on the homepage and `/discussions` shows
*topics*, one row per topic, ordered by `last_post_at` (via
`getLatestTopicsAcrossCategories`). A topic appears once and silently floats to
the top when something happens to it. Governance actions are just topics with a
status badge.

This redesign turns that column into a real **activity feed**: not "which topics
are fresh" but "what just happened", phrased as an event with actor, verb and
context. Each event is its own line, so an active thread can appear several times.
Governance actions are treated as normal topics in the stream.

Four event types, all selected:

- `topic_created`  -> "Bernd started a topic in Budget & Treasury"
- `reply_created`  -> "Juli replied in <title>" (forum) / "Juli commented on <title>" (governance)
- `gov_created`    -> "New governance action: <title>" (+ status badge)
- `gov_status`     -> "<title> was enacted / expired / moved to voting"

Architecture: an append only `activity` event log (chosen over a query time
union). The feed read becomes a single indexed query plus the same batched
hydration the homepage already does. Write paths append one row per event inside
their existing D1 batch.

## Goals

- Show forum activity the way most forums do: actor + verb + context + time, one
  line per event, newest first.
- Treat governance actions as normal topics in the stream (creation, comments,
  status changes all surface as events).
- Keep it lean and cheap: the hot read path stays a single indexed query plus the
  existing batched hydration; the extra write is one INSERT piggybacked on an
  existing batch (scales with rare writes, not with traffic).
- Reuse existing batch loaders (`getTopicsByIds`, `getGovernanceActionsByTopicIds`,
  `loadAuthorIdentities`); no new N+1.

## Non goals

- No bundling / collapsing of consecutive events. One line per event was chosen
  explicitly. A gov sync burst shows as individual `gov_created` rows (rare in
  practice, a handful per epoch at most).
- No change to the category navigation column on `/discussions`; only the
  "Latest activity" column becomes the feed.
- No new cron cadence. Emission piggybacks on the existing forum write paths and
  the existing gov sync run.
- No pruning / retention policy for the `activity` table yet (append only;
  revisit if it ever grows large; not a concern at current volume).
- `getLatestTopicsAcrossCategories` stays in the code for now; it is simply no
  longer used by the feed. Remove only if a follow up confirms it is unused.

## A. Data model: `activity` table

New migration `migrations/0030_activity_feed.sql`.

```sql
CREATE TABLE activity (
  id          TEXT PRIMARY KEY,   -- runtime: crypto.randomUUID(); backfill: '<type>:<rowid>'
  type        TEXT NOT NULL,      -- 'topic_created' | 'reply_created' | 'gov_created' | 'gov_status'
  actor_id    TEXT,               -- author wallet/user id; NULL for system events (gov_created, gov_status)
  topic_id    TEXT NOT NULL,      -- every event hangs off a topic
  ref_post_id TEXT,               -- the reply post id for reply_created (deep link); NULL otherwise
  payload     TEXT,               -- JSON; gov_status: {"to":"enacted","from":"active"}; NULL otherwise
  created_at  INTEGER NOT NULL    -- ms
);

CREATE INDEX idx_activity_created ON activity(created_at DESC);
```

Deliberately **no** denormalized title or category: those would go stale on
rename, and the feed hydrates the topic at read time anyway (the homepage does
this today). `topic_id` is enough to resolve the governance action through the
existing `getGovernanceActionsByTopicIds`, so there is no separate
`governance_id` column. `payload` is `NULL` for everything except `gov_status`.

## B. Event emission

Emission lives inside the existing write paths and rides their existing D1 batch,
so an event is always atomic with the write that caused it (no "event without a
topic" race, no extra round trip on the hot path).

| Event           | Where                                                                 | Actor        |
| --------------- | --------------------------------------------------------------------- | ------------ |
| `topic_created` | `createTopic` appends an INSERT to its batch when `source === 'user'`  | `author_id`  |
| `gov_created`   | gov sync, via the `batchWith` hook at `src/lib/governance/sync.ts:108` | NULL (system)|
| `reply_created` | `createPost` appends an INSERT to its batch                           | `author_id`  |
| `gov_status`    | tally sync, only when the derived status differs from the stored one  | NULL (system)|

Details:

- **`createTopic`** (`src/lib/db/forum.ts:149`) already builds its batch as
  `[insertTopic, insertPost, ...extra]` and exposes `batchWith`. Add a
  `topic_created` INSERT to that batch **only for `source === 'user'`**.
  `ref_post_id` is `NULL` (the event links to the topic, not the opening post).
  For `source === 'governance'`, `createTopic` emits nothing; gov sync owns that
  event (next row).
- **`gov_created`**: gov sync creates governance topics at
  `src/lib/governance/sync.ts:108` via `createTopic({ source: 'governance', batchWith })`.
  Extend that `batchWith` (which already inserts the `governance_actions` row) to
  also insert a `gov_created` activity row in the same atomic batch. It has the
  topic id (the `batchWith` arg) and the action context. `actor_id` is `NULL`,
  `payload` may carry `{"type": "<action type>"}` (optional, for display).
- **`createPost`** (`src/lib/db/forum.ts:426`) builds `[insertPost, updateTopic]`.
  Add a `reply_created` INSERT to that batch. `actor_id = author_id`,
  `ref_post_id = postId`. This covers replies to both forum and governance topics;
  the verb ("replied" vs "commented on") is decided at render from `topic.source`.
  The opening post never produces a `reply_created` (it is created by
  `createTopic`, which already emits `topic_created` / leaves it to `gov_created`).
- **`gov_status`**: in `src/lib/governance/tallySync.ts` the loop at line ~203
  already has the stored status (`ga.status`) next to the freshly derived `status`.
  When they differ, append a `gov_status` activity row
  (`payload = {"from": ga.status, "to": status}`, `actor_id = NULL`,
  `created_at = now`). `updateGovernanceTallyAndStatus` runs on every tally
  refresh, so the **status-changed** comparison is what gates emission, not the
  update itself. A separate INSERT after the update is fine here (cron path, not
  latency sensitive); batching with the update is acceptable too.

A small shared insert helper (e.g. `activityInsert(db, {...})` returning a
`D1PreparedStatement`, in `src/lib/db/activity.ts`) keeps the four call sites
consistent and avoids duplicating the column list.

## C. Backfill (one time, in the migration)

So the feed is not empty after deploy, the migration backfills from existing data.
Deterministic ids (`'<type>:'||id`) keep it safe to reason about; real `created_at`
so rows slot into the timeline correctly.

- `topic_created`: from `topics WHERE source = 'user' AND deleted = 0`
  -> `('topic_created:'||id, 'topic_created', author_id, id, NULL, NULL, created_at)`
- `gov_created`: from `topics WHERE source = 'governance' AND deleted = 0`
  -> `('gov_created:'||id, 'gov_created', NULL, id, NULL, NULL, created_at)`
- `reply_created`: every post **except its topic's opening post**, excluding
  deleted/hidden posts and posts in deleted topics. The opening post is the
  earliest post per `topic_id`:

  ```sql
  INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
  SELECT 'reply_created:'||p.id, 'reply_created', p.author_id, p.topic_id, p.id, NULL, p.created_at
  FROM posts p
  JOIN topics t ON t.id = p.topic_id
  WHERE p.deleted = 0 AND p.hidden = 0 AND t.deleted = 0
    AND p.id <> (
      SELECT id FROM posts
      WHERE topic_id = p.topic_id
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    );
  ```

  The `created_at ASC, id ASC` tiebreaker picks a single deterministic opener even
  if two posts share a timestamp.
- `gov_status`: **not** backfilled (no transition history exists). These start
  accruing from deploy forward.

The backfill subquery per post is acceptable at the forum's current low volume.

## D. Read and hydration

New `src/lib/db/activity.ts`:

- `interface ActivityRow` mirrors the table columns.
- `getRecentActivity(db, { limit })`: a single
  `SELECT * FROM activity ORDER BY created_at DESC LIMIT ?` (cap the limit, e.g. 50,
  like the other readers). Over fetch a small buffer so rows filtered out below do
  not shorten the list noticeably.
- `activityInsert(...)`: the shared prepared statement builder used by the four
  emission sites (section B).

New `src/lib/forum/activityFeed.ts` with `loadActivityFeed(db, { limit })`:

1. `getRecentActivity(db, { limit: limit + buffer })`.
2. Collect distinct `topic_id`s -> `getTopicsByIds` (titles, slugs, category,
   source, deleted).
3. Drop events whose topic is missing or `deleted` (so removed content does not
   surface), then slice to `limit`.
4. Collect governance topic ids (topic `source === 'governance'`) ->
   `getGovernanceActionsByTopicIds` for the badge / current status.
5. Collect distinct non null `actor_id`s -> `loadAuthorIdentities`.
6. Map to a view model array `ActivityEvent[]` (see section E).

All three loaders already exist and are batched, so hydration stays the same
shape (and roughly the same cost) as the homepage's current topic hydration.

## E. View model

```ts
type ActivityKind = 'topic_created' | 'reply_created' | 'gov_created' | 'gov_status';

interface ActivityEvent {
  kind: ActivityKind;
  createdAt: number;
  actor: AuthorDescriptor | null;     // null => system event, render system icon
  topic: { title: string; slug: string; categorySlug: string; isGovernance: boolean };
  governanceStatus?: string;          // for gov_created / gov_status badge
  statusTransition?: { from: string; to: string };  // gov_status only
  refPostId?: string | null;          // reply_created deep link target
}
```

## F. Rendering

New `src/components/ActivityRow.astro`. It replaces `TopicRow` **only** inside the
feed; `TopicRow` stays in use for the category browse pages. One line per event,
UI language English (matching the existing site). Phrasing:

- `topic_created`: "<actor> started a topic in <Category>" -> links to the topic.
- `reply_created`, forum topic: "<actor> replied in <Title>".
- `reply_created`, governance topic: "<actor> commented on <Title>".
- `gov_created`: "New governance action: <Title>" + status badge.
- `gov_status`: "<Title> was enacted / expired / moved to voting" (verb from
  `statusTransition.to`, reusing the existing `statusBadge` label mapping).

System events (governance, `actor == null`) render a neutral system icon instead
of a person avatar. `reply_created` links to the post anchor via `refPostId`
(`/<topic url>#post-<id>` or the thread view's existing anchor scheme; confirm the
exact pattern during implementation), falling back to the topic link.
Relative time reuses whatever helper `TopicRow` uses today.

## G. Wiring

- `src/pages/index.astro`: replace the
  `getLatestTopicsAcrossCategories(db, { limit: 4 })` + governance + author
  hydration block with `loadActivityFeed(db, { limit: 6 })`; render `ActivityRow`
  rows. "View all discussions" link unchanged.
- `src/pages/discussions.astro`: same swap with `limit: 30`. The category
  navigation column is unchanged; only the "Latest activity" column becomes the
  feed.
- Empty state: when the feed is empty, show a short "No recent activity yet" line
  (backfill makes this unlikely, but handle it).

## H. Testing

Vitest workers tests (real D1), following the existing `*.workers.test.ts` pattern:

- `createTopic` emits exactly one `topic_created` for `source = 'user'` and **none**
  for `source = 'governance'`.
- `createPost` emits exactly one `reply_created` with `ref_post_id = post.id`.
- gov sync `batchWith` emits a `gov_created` for a new governance topic.
- tally sync emits a `gov_status` **only** when the derived status differs from the
  stored one, and not on a same status tally refresh.
- `getRecentActivity` returns rows in `created_at DESC` order, respecting the limit.
- `loadActivityFeed` hydrates titles/authors/governance, filters out events whose
  topic is deleted, and maps each kind to the right verb (forum "replied" vs
  governance "commented on").

## File touch list

- `migrations/0030_activity_feed.sql` (new: table, index, backfill)
- `src/lib/db/activity.ts` (new: row type, `getRecentActivity`, `activityInsert`)
- `src/lib/forum/activityFeed.ts` (new: `loadActivityFeed`, view model mapping)
- `src/components/ActivityRow.astro` (new)
- `src/lib/db/forum.ts` (`createTopic`, `createPost` emit events)
- `src/lib/governance/sync.ts` (extend `batchWith` to emit `gov_created`)
- `src/lib/governance/tallySync.ts` (emit `gov_status` on transition)
- `src/pages/index.astro`, `src/pages/discussions.astro` (use `loadActivityFeed`)
- tests alongside the above per the existing convention
