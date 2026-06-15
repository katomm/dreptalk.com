# Discussions Activity Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Latest activity" topic list on the homepage and `/discussions` with a forum style activity feed: one line per event (new topic, reply, new governance action, governance status change), newest first.

**Architecture:** An append only `activity` event log. The four forum/governance write paths each append one event row inside their existing D1 batch. The feed read is a single indexed query plus the same batched hydration the homepage already does (`getTopicsByIds`, `getGovernanceActionsByTopicIds`, `loadAuthorIdentities`). A new `ActivityRow.astro` renders each event; it replaces `TopicRow` only inside the feed.

**Tech Stack:** Astro 6 (SSR, `export const prerender = false`), Cloudflare Workers + D1, TypeScript, Vitest with `@cloudflare/vitest-pool-workers` (real workerd + D1, migrations auto-applied, tables reset before each test).

Spec: `docs/specs/2026-06-15-discussions-activity-feed-design.md`.

**Test commands (used throughout):**
- Workers test (single file): `npx vitest run --config vitest.workers.config.ts <path>`
- Node test (single file): `npx vitest run --config vitest.config.ts <path>`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Build: `npm run build`

---

## File Structure

- `migrations/0030_activity_feed.sql` (new): table, index, one time backfill.
- `src/lib/db/activity.ts` (new): `ActivityKind`, `ActivityRow`, `activityInsert()` (prepared statement builder for the four emission sites), `getRecentActivity()`.
- `src/lib/forum/activityFeed.ts` (new): `ActivityEvent` view model, `loadActivityFeed()` (read + batched hydration + deleted filter + mapping).
- `src/lib/governance/view.ts` (modify): add pure `govStatusVerb()`.
- `src/components/ActivityRow.astro` (new): renders one event line.
- `src/lib/db/forum.ts` (modify): `createTopic` emits `topic_created` (user topics only); `createPost` emits `reply_created`.
- `src/lib/governance/sync.ts` (modify): gov sync `batchWith` emits `gov_created`.
- `src/lib/governance/tallySync.ts` (modify): emit `gov_status` on a real status transition.
- `src/pages/index.astro`, `src/pages/discussions.astro` (modify): use `loadActivityFeed` + `ActivityRow`.
- Tests: `src/lib/db/activity.workers.test.ts` (new), `src/lib/forum/activityFeed.workers.test.ts` (new); additions to `src/lib/governance/sync.workers.test.ts`, `src/lib/governance/tallySync.workers.test.ts`, `src/lib/governance/view.test.ts`.

---

## Task 1: Activity table migration + backfill

**Files:**
- Create: `migrations/0030_activity_feed.sql`

The migration creates the append only event log, its read index, and backfills
the three derivable event types from existing data (`gov_status` has no history,
so it is not backfilled and starts accruing from deploy forward). Migrations are
applied automatically by the workers test pool, so a malformed statement breaks
every workers test; that is the verification for this DDL-only task.

- [ ] **Step 1: Write the migration file**

Create `migrations/0030_activity_feed.sql`:

```sql
-- Append only forum activity event log. One row per event (new topic, reply,
-- new governance action, governance status change). The "Latest activity" feed
-- on the homepage and /discussions reads the newest N rows from here.
--
-- Deliberately no denormalized title/category: those would go stale on rename,
-- and the feed hydrates the topic at read time anyway. topic_id is enough to
-- resolve the governance action (via governance_actions.topic_id). payload is
-- NULL for everything except gov_status, where it carries {"from":..,"to":..}.
CREATE TABLE activity (
  id          TEXT PRIMARY KEY,   -- runtime: crypto.randomUUID(); backfill: '<type>:<rowid>'
  type        TEXT NOT NULL,      -- 'topic_created' | 'reply_created' | 'gov_created' | 'gov_status'
  actor_id    TEXT,               -- author wallet/user id; NULL for system events (gov_created, gov_status)
  topic_id    TEXT NOT NULL,
  ref_post_id TEXT,               -- the reply post id for reply_created (deep link); NULL otherwise
  payload     TEXT,               -- JSON; gov_status: {"from":"active","to":"enacted"}; NULL otherwise
  created_at  INTEGER NOT NULL
);

-- The feed's only access pattern: newest first.
CREATE INDEX idx_activity_created ON activity(created_at DESC);

-- Backfill: user-created topics become topic_created events.
INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
SELECT 'topic_created:' || id, 'topic_created', author_id, id, NULL, NULL, created_at
FROM topics
WHERE source = 'user' AND deleted = 0;

-- Backfill: governance topics become gov_created events (system, no actor).
INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
SELECT 'gov_created:' || id, 'gov_created', NULL, id, NULL, NULL, created_at
FROM topics
WHERE source = 'governance' AND deleted = 0;

-- Backfill: every post EXCEPT its topic's opening post becomes a reply_created
-- event. The opening post is the earliest post per topic (created in the same
-- batch as the topic). The created_at ASC, id ASC tiebreaker picks a single
-- deterministic opener even when two posts share a timestamp. Deleted/hidden
-- posts and posts in deleted topics are excluded.
INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
SELECT 'reply_created:' || p.id, 'reply_created', p.author_id, p.topic_id, p.id, NULL, p.created_at
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

- [ ] **Step 2: Verify migrations still apply by running an existing workers test**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/forumOverview.workers.test.ts`
Expected: PASS. (The workers pool applies every migration in `migrations/` before the suite; malformed SQL in 0030 would fail this run during setup.)

- [ ] **Step 3: Commit**

```bash
git add migrations/0030_activity_feed.sql
git commit -m "feat: add activity event log table and backfill"
```

---

## Task 2: `activity.ts` insert builder and reader

**Files:**
- Create: `src/lib/db/activity.ts`
- Test: `src/lib/db/activity.workers.test.ts`

`activityInsert()` returns a `D1PreparedStatement` so the four emission sites can
append it to their existing batch. `getRecentActivity()` is the feed's single
read query.

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/activity.workers.test.ts`:

```ts
/// <reference types="@cloudflare/workers-types" />
// Activity event log tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { activityInsert, getRecentActivity } from './activity.js';

const db = () => env.DB;

describe('activityInsert + getRecentActivity', () => {
  it('inserts a row and reads it back', async () => {
    await activityInsert(db(), {
      type: 'topic_created',
      topicId: 'topic-1',
      actorId: 'author-1',
      createdAt: 1000,
    }).run();

    const rows = await getRecentActivity(db(), { limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      type: 'topic_created',
      topic_id: 'topic-1',
      actor_id: 'author-1',
      ref_post_id: null,
      payload: null,
      created_at: 1000,
    });
  });

  it('serializes payload as JSON and leaves system actor null', async () => {
    await activityInsert(db(), {
      type: 'gov_status',
      topicId: 'topic-2',
      payload: { from: 'active', to: 'enacted' },
      createdAt: 2000,
    }).run();

    const rows = await getRecentActivity(db(), { limit: 10 });
    const row = rows.find((r) => r.topic_id === 'topic-2')!;
    expect(row.actor_id).toBeNull();
    expect(JSON.parse(row.payload as string)).toEqual({ from: 'active', to: 'enacted' });
  });

  it('orders newest first and respects the limit', async () => {
    await activityInsert(db(), { type: 'reply_created', topicId: 't', createdAt: 100 }).run();
    await activityInsert(db(), { type: 'reply_created', topicId: 't', createdAt: 300 }).run();
    await activityInsert(db(), { type: 'reply_created', topicId: 't', createdAt: 200 }).run();

    const rows = await getRecentActivity(db(), { limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows[0].created_at).toBe(300);
    expect(rows[1].created_at).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/activity.workers.test.ts`
Expected: FAIL (cannot resolve `./activity.js` / `activityInsert` not exported).

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/activity.ts`:

```ts
/// <reference types="@cloudflare/workers-types" />
// Append only forum activity event log: an insert builder used by the four
// emission sites (createTopic, createPost, gov sync discovery, gov tally sync)
// and the single read query that powers the "Latest activity" feed. The feed's
// hydration (titles, authors, governance) lives in src/lib/forum/activityFeed.ts.

export type ActivityKind = 'topic_created' | 'reply_created' | 'gov_created' | 'gov_status';

// Raw row shape as stored in D1. payload is a JSON string (or null); the feed
// loader parses it for gov_status.
export interface ActivityRow {
  id: string;
  type: ActivityKind;
  actor_id: string | null;
  topic_id: string;
  ref_post_id: string | null;
  payload: string | null;
  created_at: number;
}

/**
 * Builds an INSERT for one activity event as a prepared statement, so callers
 * can append it to their existing D1 batch (the event is then atomic with the
 * write that caused it). The id is a fresh UUID; payload is JSON-encoded when
 * present. System events (gov_created, gov_status) pass no actorId.
 */
export function activityInsert(
  db: D1Database,
  a: {
    type: ActivityKind;
    topicId: string;
    actorId?: string | null;
    refPostId?: string | null;
    payload?: Record<string, unknown> | null;
    createdAt: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO activity (id, type, actor_id, topic_id, ref_post_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      a.type,
      a.actorId ?? null,
      a.topicId,
      a.refPostId ?? null,
      a.payload ? JSON.stringify(a.payload) : null,
      a.createdAt,
    );
}

/**
 * Returns the newest activity events, newest first. The id DESC tiebreaker keeps
 * the order deterministic when two events share a created_at (backfilled rows
 * commonly do). Default limit 30, capped at 50.
 */
export async function getRecentActivity(
  db: D1Database,
  opts?: { limit?: number },
): Promise<ActivityRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 50);
  const rows = await db
    .prepare('SELECT * FROM activity ORDER BY created_at DESC, id DESC LIMIT ?')
    .bind(limit)
    .all<ActivityRow>();
  return rows.results ?? [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/activity.workers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/activity.ts src/lib/db/activity.workers.test.ts
git commit -m "feat: add activity insert builder and reader"
```

---

## Task 3: Emit `topic_created` and `reply_created` from the forum write paths

**Files:**
- Modify: `src/lib/db/forum.ts` (import; `createTopic` batch ~line 191-192; `createPost` batch ~line 493)
- Test: `src/lib/db/activity.workers.test.ts` (add a describe block)

`createTopic` emits `topic_created` only for `source === 'user'`; a
governance-sourced topic is emitted by gov sync as `gov_created` (Task 4).
`createPost` emits `reply_created` for every reply.

- [ ] **Step 1: Add the failing tests**

Append to `src/lib/db/activity.workers.test.ts`:

```ts
import { createTopic, createPost } from './forum.js';

describe('forum write paths emit activity', () => {
  it('createTopic emits one topic_created for a user topic', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: 'user-a',
      title: 'Hello',
      bodyMd: 'b',
      bodyHtml: '<p>b</p>',
      now: 5000,
      rand: 'act1',
    });

    const rows = await getRecentActivity(db(), { limit: 10 });
    const mine = rows.filter((r) => r.topic_id === topic.id);
    expect(mine.length).toBe(1);
    expect(mine[0]).toMatchObject({
      type: 'topic_created',
      actor_id: 'user-a',
      ref_post_id: null,
      created_at: 5000,
    });
  });

  it('createTopic emits NO activity for a governance topic', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'governance-actions',
      authorId: 'gov-sync',
      title: 'Gov',
      bodyMd: 'b',
      bodyHtml: '<p>b</p>',
      source: 'governance',
      now: 6000,
      rand: 'act2',
    });

    const rows = await getRecentActivity(db(), { limit: 10 });
    expect(rows.filter((r) => r.topic_id === topic.id).length).toBe(0);
  });

  it('createPost emits one reply_created with the post id', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: 'user-a',
      title: 'Thread',
      bodyMd: 'b',
      bodyHtml: '<p>b</p>',
      now: 7000,
      rand: 'act3',
    });
    const reply = await createPost(db(), {
      topicId: topic.id,
      authorId: 'user-b',
      bodyMd: 'r',
      bodyHtml: '<p>r</p>',
      now: 8000,
    });

    const rows = await getRecentActivity(db(), { limit: 10 });
    const replies = rows.filter((r) => r.topic_id === topic.id && r.type === 'reply_created');
    expect(replies.length).toBe(1);
    expect(replies[0]).toMatchObject({
      actor_id: 'user-b',
      ref_post_id: reply.id,
      created_at: 8000,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/activity.workers.test.ts`
Expected: FAIL (the three new tests: no activity rows are emitted yet).

- [ ] **Step 3: Add the import to `src/lib/db/forum.ts`**

After the existing import on line 6 (`import { sqlPlaceholders } from './sql.js';`), add:

```ts
import { activityInsert } from './activity.js';
```

- [ ] **Step 4: Emit `topic_created` in `createTopic`**

In `src/lib/db/forum.ts`, replace these two lines (currently ~191-192):

```ts
  const extra = batchWith ? batchWith(topicId) : [];
  await db.batch([insertTopic, insertPost, ...extra]);
```

with:

```ts
  const extra = batchWith ? batchWith(topicId) : [];
  // A user-created topic emits a 'topic_created' event in the same atomic batch.
  // Governance-sourced topics are emitted by gov sync as 'gov_created' (it has
  // the on-chain action context), so they emit nothing here.
  const events =
    source === 'user'
      ? [activityInsert(db, { type: 'topic_created', topicId, actorId: authorId, createdAt: postedAt })]
      : [];
  await db.batch([insertTopic, insertPost, ...events, ...extra]);
```

- [ ] **Step 5: Emit `reply_created` in `createPost`**

In `src/lib/db/forum.ts`, replace this line (currently ~493):

```ts
  await db.batch([insertPost, updateTopic]);
```

with:

```ts
  await db.batch([
    insertPost,
    updateTopic,
    // The reply is a feed event; emit it atomically with the post.
    activityInsert(db, { type: 'reply_created', topicId, actorId: authorId, refPostId: postId, createdAt: now }),
  ]);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/activity.workers.test.ts`
Expected: PASS (all tests, including the 3 from Task 2).

- [ ] **Step 7: Run the existing forum tests to confirm no regression**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/db/forumOverview.workers.test.ts src/lib/forum/handlers.workers.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/forum.ts src/lib/db/activity.workers.test.ts
git commit -m "feat: emit topic and reply activity events"
```

---

## Task 4: Emit `gov_created` from gov sync

**Files:**
- Modify: `src/lib/governance/sync.ts` (import; `batchWith` array ~line 118-137)
- Test: `src/lib/governance/sync.workers.test.ts` (add an assertion)

Gov sync creates the governance topic and the `governance_actions` row in one
atomic batch via `createTopic({ source: 'governance', batchWith })`. Add the
`gov_created` event to that same `batchWith` so it is atomic too. The event's
`created_at` is the on-chain submission time (`submittedAtMs`), matching the
topic's own `created_at`, so the feed and the topic agree on the action's date.

- [ ] **Step 1: Add the failing assertion**

In `src/lib/governance/sync.workers.test.ts`, inside the existing
`describe('syncGovernanceActions')` first test (`'creates a thread + governance_actions row per new action, then is idempotent'`), after the block that asserts `topics.length === 2`, add:

```ts
    // Each new governance topic emits exactly one gov_created activity event.
    const govEvents = (
      await env.DB.prepare("SELECT topic_id, type, actor_id FROM activity WHERE type = 'gov_created'").all<{
        topic_id: string;
        type: string;
        actor_id: string | null;
      }>()
    ).results;
    expect(govEvents.length).toBe(2);
    expect(govEvents.every((e) => e.actor_id === null)).toBe(true);
    // No topic_created events for governance topics.
    const topicCreated = (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE type = 'topic_created'").first<{ n: number }>()
    )!;
    expect(topicCreated.n).toBe(0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/governance/sync.workers.test.ts`
Expected: FAIL (`govEvents.length` is 0, no events emitted yet).

- [ ] **Step 3: Add the import to `src/lib/governance/sync.ts`**

After the existing forum import on line 11 (`import { createTopic, setTopicPostedAt, getAllTopicsByCategory } from '../db/forum.js';`), add:

```ts
import { activityInsert } from '../db/activity.js';
```

- [ ] **Step 4: Emit `gov_created` in the `batchWith`**

In `src/lib/governance/sync.ts`, the `batchWith` callback (currently ~line 118) returns an array with a single `buildInsertGovernanceAction(...)` statement. Add the activity insert as a second element. Replace:

```ts
        batchWith: (topicId) => [
          buildInsertGovernanceAction(db, {
            id,
            proposalId: p.proposal_id,
            type: p.proposal_type,
            title: meta?.title ?? null,
            abstract: meta?.abstract ?? null,
            rationaleHtml: meta?.rationaleHtml ?? null,
            anchorUrl: p.meta_url ?? null,
            anchorHash: p.meta_hash ?? null,
            anchorStatus: anchor.status,
            returnAddress: p.return_address ?? null,
            deposit: p.deposit ?? null,
            submittedEpoch: p.proposed_epoch ?? null,
            expiryEpoch: p.expiration ?? null,
            metaVersion: META_EXTRACT_VERSION,
            topicId,
            now,
          }),
        ],
```

with:

```ts
        batchWith: (topicId) => [
          buildInsertGovernanceAction(db, {
            id,
            proposalId: p.proposal_id,
            type: p.proposal_type,
            title: meta?.title ?? null,
            abstract: meta?.abstract ?? null,
            rationaleHtml: meta?.rationaleHtml ?? null,
            anchorUrl: p.meta_url ?? null,
            anchorHash: p.meta_hash ?? null,
            anchorStatus: anchor.status,
            returnAddress: p.return_address ?? null,
            deposit: p.deposit ?? null,
            submittedEpoch: p.proposed_epoch ?? null,
            expiryEpoch: p.expiration ?? null,
            metaVersion: META_EXTRACT_VERSION,
            topicId,
            now,
          }),
          // The newly discovered action is a feed event. created_at is the
          // submission time (same as the topic's), so the feed and the topic
          // agree on the action's date.
          activityInsert(db, {
            type: 'gov_created',
            topicId,
            payload: { type: p.proposal_type },
            createdAt: submittedAtMs,
          }),
        ],
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/governance/sync.workers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/governance/sync.ts src/lib/governance/sync.workers.test.ts
git commit -m "feat: emit gov_created activity event on action discovery"
```

---

## Task 5: Emit `gov_status` on a real status transition

**Files:**
- Modify: `src/lib/governance/tallySync.ts` (import; after the update call ~line 203-212)
- Test: `src/lib/governance/tallySync.workers.test.ts` (add a describe block)

The tally loop processes `active` and `pending` actions; it has the stored
status (`ga.status`) next to the freshly derived `status`. Emit `gov_status`
only when they differ (a same status tally refresh emits nothing). A new action
is stored as `'pending'` (see `buildInsertGovernanceAction`), so its first real
sync (pending -> active) emits, and the next unchanged sync does not.

- [ ] **Step 1: Add the failing tests**

In `src/lib/governance/tallySync.workers.test.ts`, add this describe block at the end of the file (it reuses the file's existing `db`, `NOW`, `insertActive`, `lifeRow`, and `fakeTallyKoios` helpers):

```ts
describe('syncGovernanceTallies emits gov_status', () => {
  async function statusEvents(topicId: string) {
    return (
      await db()
        .prepare("SELECT payload FROM activity WHERE type = 'gov_status' AND topic_id = ? ORDER BY created_at ASC")
        .bind(topicId)
        .all<{ payload: string }>()
    ).results.map((r) => JSON.parse(r.payload));
  }

  it('emits on pending -> active, and not again when unchanged', async () => {
    const { txHash, topicId } = await insertActive(294);

    // First sync: pending (stored) -> active (derived) emits one event.
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(txHash)]),
      db: db(),
      currentEpoch: 290,
      now: NOW,
    });
    let events = await statusEvents(topicId);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ from: 'pending', to: 'active' });

    // Second sync: active -> active, no new event.
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(txHash)]),
      db: db(),
      currentEpoch: 291,
      now: NOW + 1000,
    });
    events = await statusEvents(topicId);
    expect(events.length).toBe(1);
  });

  it('emits on a transition to a terminal status', async () => {
    const { txHash, topicId } = await insertActive(294);

    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(txHash, { enacted_epoch: 292 })]),
      db: db(),
      currentEpoch: 293,
      now: NOW,
    });
    const events = await statusEvents(topicId);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ from: 'pending', to: 'enacted' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/governance/tallySync.workers.test.ts`
Expected: FAIL (no `gov_status` rows emitted yet).

- [ ] **Step 3: Add the import to `src/lib/governance/tallySync.ts`**

After the `upsertVotes` import on line 20 (`import { upsertVotes, type VoteInput } from '../db/drepVotes.js';`), add:

```ts
import { activityInsert } from '../db/activity.js';
```

- [ ] **Step 4: Emit `gov_status` after the update**

In `src/lib/governance/tallySync.ts`, find the `updateGovernanceTallyAndStatus` call inside the loop (currently ~line 203-212):

```ts
      await updateGovernanceTallyAndStatus(db, {
        id: ga.id,
        status,
        ...tallyFields(summary),
        decidedEpoch,
        tallySyncedAt: now,
        now,
      });

      updated++;
```

Replace it with:

```ts
      await updateGovernanceTallyAndStatus(db, {
        id: ga.id,
        status,
        ...tallyFields(summary),
        decidedEpoch,
        tallySyncedAt: now,
        now,
      });

      // A real lifecycle transition (pending -> active, active -> enacted, etc.)
      // is a feed event; a same-status tally refresh is not. created_at = now,
      // since the change is happening now (unlike gov_created's submission time).
      if (status !== ga.status && ga.topicId) {
        await activityInsert(db, {
          type: 'gov_status',
          topicId: ga.topicId,
          payload: { from: ga.status, to: status },
          createdAt: now,
        }).run();
      }

      updated++;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/governance/tallySync.workers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/governance/tallySync.ts src/lib/governance/tallySync.workers.test.ts
git commit -m "feat: emit gov_status activity event on lifecycle change"
```

---

## Task 6: `loadActivityFeed` read, hydrate, map to view model

**Files:**
- Create: `src/lib/forum/activityFeed.ts`
- Test: `src/lib/forum/activityFeed.workers.test.ts`

Reads the newest events, batch-hydrates topics/governance/authors with existing
loaders, drops events whose topic is deleted, and maps each row to a ready
`ActivityEvent`. `loadAuthorIdentities` already skips the system author and null
ids, so system events (null actor) need no special handling there.

- [ ] **Step 1: Write the failing test**

Create `src/lib/forum/activityFeed.workers.test.ts`:

```ts
/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost } from '../db/forum.js';
import { loadActivityFeed } from './activityFeed.js';

const db = () => env.DB;

describe('loadActivityFeed', () => {
  it('maps a forum reply to a commented/replied event with author and title', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'budget',
      authorId: 'user-a',
      title: 'Budget thread',
      bodyMd: 'b',
      bodyHtml: '<p>b</p>',
      now: 1000,
      rand: 'feed1',
    });
    await createPost(db(), {
      topicId: topic.id,
      authorId: 'user-b',
      bodyMd: 'r',
      bodyHtml: '<p>r</p>',
      now: 2000,
    });

    const feed = await loadActivityFeed(db(), { limit: 10 });

    // Newest first: the reply, then the topic creation.
    expect(feed[0].kind).toBe('reply_created');
    expect(feed[0].topic.title).toBe('Budget thread');
    expect(feed[0].topic.categoryName).toBe('Budget and Treasury');
    expect(feed[0].topic.isGovernance).toBe(false);
    expect(feed[0].refPostId).not.toBeNull();
    expect(feed[0].actor?.authorId).toBe('user-b');

    expect(feed[1].kind).toBe('topic_created');
    expect(feed[1].actor?.authorId).toBe('user-a');
  });

  it('drops events whose topic is deleted', async () => {
    const { topic } = await createTopic(db(), {
      categorySlug: 'general',
      authorId: 'user-c',
      title: 'Doomed',
      bodyMd: 'b',
      bodyHtml: '<p>b</p>',
      now: 3000,
      rand: 'feed2',
    });
    await db().prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(topic.id).run();

    const feed = await loadActivityFeed(db(), { limit: 10 });
    expect(feed.some((e) => e.topic.title === 'Doomed')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/forum/activityFeed.workers.test.ts`
Expected: FAIL (cannot resolve `./activityFeed.js`).

- [ ] **Step 3: Write the implementation**

Create `src/lib/forum/activityFeed.ts`:

```ts
/// <reference types="@cloudflare/workers-types" />
// Reads the newest activity events and hydrates them into ready view models for
// the "Latest activity" feed (homepage + /discussions). All hydration is batched
// through existing loaders (getTopicsByIds, getGovernanceActionsByTopicIds,
// loadAuthorIdentities), so there is no N+1. Events whose topic was deleted are
// dropped, so removed content never surfaces in the feed.

import { getRecentActivity, type ActivityKind } from '../db/activity.js';
import { getTopicsByIds } from '../db/forum.js';
import { getGovernanceActionsByTopicIds } from '../db/governance.js';
import { loadAuthorIdentities, type AuthorDescriptor } from './author.js';
import { getCategory } from '../../../config/categories.js';

export interface ActivityEvent {
  kind: ActivityKind;
  createdAt: number;
  /** Resolved author, or null for system events (gov_created, gov_status). */
  actor: AuthorDescriptor | null;
  topic: {
    title: string;
    slug: string;
    categoryName: string;
    isGovernance: boolean;
  };
  /** Current governance status, for the badge on gov_created / gov_status. */
  governanceStatus: string | null;
  /** The from/to of a gov_status event; null otherwise. */
  statusTransition: { from: string; to: string } | null;
  /** Reply post id for the deep link on reply_created; null otherwise. */
  refPostId: string | null;
}

function parseTransition(payload: string | null): { from: string; to: string } | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as { from?: unknown; to?: unknown };
    if (typeof p.from === 'string' && typeof p.to === 'string') return { from: p.from, to: p.to };
  } catch {
    // Malformed payload: treat as no transition rather than throwing in a render path.
  }
  return null;
}

/**
 * Loads the newest activity events as ready view models, newest first. Over-fetches
 * a small buffer so events filtered out (deleted topics) do not shorten the list,
 * then caps to `limit`. Default limit 20, capped at 50.
 */
export async function loadActivityFeed(
  db: D1Database,
  opts?: { limit?: number },
): Promise<ActivityEvent[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 50);
  const rows = await getRecentActivity(db, { limit: Math.min(limit + 10, 50) });
  if (rows.length === 0) return [];

  const topicIds = [...new Set(rows.map((r) => r.topic_id))];
  const topicsById = await getTopicsByIds(db, topicIds);

  // Keep only events whose topic still exists and is live, then cap to limit.
  const live = rows
    .filter((r) => {
      const t = topicsById.get(r.topic_id);
      return t && !t.deleted;
    })
    .slice(0, limit);

  const govTopicIds = live
    .filter((r) => topicsById.get(r.topic_id)?.source === 'governance')
    .map((r) => r.topic_id);

  const [identities, govByTopic] = await Promise.all([
    loadAuthorIdentities(db, live.map((r) => r.actor_id)),
    govTopicIds.length ? getGovernanceActionsByTopicIds(db, govTopicIds) : Promise.resolve(new Map()),
  ]);

  return live.map((r) => {
    // Non-null: live was filtered to events whose topic is present.
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
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts src/lib/forum/activityFeed.workers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/forum/activityFeed.ts src/lib/forum/activityFeed.workers.test.ts
git commit -m "feat: add activity feed loader and view model"
```

---

## Task 7: `govStatusVerb` helper + `ActivityRow.astro` component

**Files:**
- Modify: `src/lib/governance/view.ts` (add `govStatusVerb`)
- Test: `src/lib/governance/view.test.ts` (add a describe block)
- Create: `src/components/ActivityRow.astro`

`govStatusVerb` is a pure mapping (unit-tested in the node pool with the other
view helpers). `ActivityRow.astro` is presentational; it is verified by typecheck
and build in Task 8 (Astro components have no unit test here).

- [ ] **Step 1: Add the failing test for `govStatusVerb`**

In `src/lib/governance/view.test.ts`, add this describe block (and add `govStatusVerb` to the existing `from './view.js'` import at the top of the file):

```ts
describe('govStatusVerb', () => {
  it('maps statuses to past-tense feed verbs', () => {
    expect(govStatusVerb('active')).toBe('moved to voting');
    expect(govStatusVerb('enacted')).toBe('was enacted');
    expect(govStatusVerb('ratified')).toBe('was ratified');
    expect(govStatusVerb('dropped')).toBe('was dropped');
    expect(govStatusVerb('expired')).toBe('expired');
    expect(govStatusVerb('closed')).toBe('was closed');
  });

  it('falls back to a generic phrase for an unknown status', () => {
    expect(govStatusVerb('whatever')).toBe('is now whatever');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config vitest.config.ts src/lib/governance/view.test.ts`
Expected: FAIL (`govStatusVerb` not exported).

- [ ] **Step 3: Implement `govStatusVerb`**

In `src/lib/governance/view.ts`, add after the `statusBadge` function (after line 52):

```ts
/**
 * Past-tense verb phrase for a governance status change, used by the activity
 * feed ("<Title> was enacted"). Mirrors the statusBadge vocabulary; 'active' is
 * the pending -> active transition, phrased as entering the voting window.
 */
export function govStatusVerb(to: string): string {
  switch (to) {
    case 'active':
      return 'moved to voting';
    case 'ratified':
      return 'was ratified';
    case 'enacted':
      return 'was enacted';
    case 'dropped':
      return 'was dropped';
    case 'expired':
      return 'expired';
    case 'closed':
      return 'was closed';
    default:
      return `is now ${to}`;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.config.ts src/lib/governance/view.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `ActivityRow.astro`**

Create `src/components/ActivityRow.astro`:

```astro
---
// One activity feed line: actor (or a system icon for governance events), a
// kind-specific verb, the linked topic title, an optional category tag or status
// badge, and the relative time. Pure presentation; loadActivityFeed resolves all
// data and passes a ready ActivityEvent in. Replaces TopicRow only inside the
// "Latest activity" feed; TopicRow still powers the category browse pages.
import type { ActivityEvent } from '@/lib/forum/activityFeed.js';
import AuthorIdentity from './AuthorIdentity.astro';
import { formatRelativeTime } from '@/lib/forum/view.js';
import { statusBadge, govStatusVerb, TONE_COLORS } from '@/lib/governance/view.js';

interface Props {
  event: ActivityEvent;
  now: number;
}

const { event, now } = Astro.props;

// Replies deep-link to the post; everything else links to the topic.
const href = event.refPostId
  ? `/t/${event.topic.slug}#post-${event.refPostId}`
  : `/t/${event.topic.slug}`;

// Status badge for governance events (creation + status change).
const badge =
  (event.kind === 'gov_created' || event.kind === 'gov_status') && event.governanceStatus
    ? statusBadge(event.governanceStatus)
    : null;

// Shared inline styles (kept here so the markup below reads cleanly).
const LINK = 'font-weight:500;text-decoration:none;color:var(--fg);';
---

<div style="border-bottom:1px solid var(--border);padding:0.75rem 0;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;font-size:0.875rem;line-height:1.5;color:var(--muted);">
  {event.actor ? (
    <AuthorIdentity author={event.actor} size={22} />
  ) : (
    <span aria-hidden="true" style="display:inline-flex;width:22px;height:22px;border-radius:999px;align-items:center;justify-content:center;flex-shrink:0;background:color-mix(in srgb, var(--accent) 14%, transparent);color:var(--accent);">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18" /><path d="M5 21V10l7-5 7 5v11" /><path d="M9 21v-6h6v6" /></svg>
    </span>
  )}

  <span style="color:var(--fg);min-width:0;">
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
  </span>

  {badge && (
    <span style={`font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;color:#fff;background:${TONE_COLORS[badge.tone]};border-radius:0.25rem;padding:0.05rem 0.4rem;`}>
      {badge.label}
    </span>
  )}

  <span style="color:var(--muted);white-space:nowrap;">{formatRelativeTime(event.createdAt, now)}</span>
</div>
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/governance/view.ts src/lib/governance/view.test.ts src/components/ActivityRow.astro
git commit -m "feat: add activity row component and status verb helper"
```

---

## Task 8: Wire the feed into the homepage and `/discussions`

**Files:**
- Modify: `src/pages/index.astro` (imports; data load ~line 21-38; render ~line 246-266)
- Modify: `src/pages/discussions.astro` (imports; data load ~line 7-30; render ~line 73-90)

Swap the topic list for the event feed. The homepage keeps its hero (which uses
`getLatestGovernanceAction`); only the "Latest activity" column changes. The
category navigation column is unchanged on both pages.

- [ ] **Step 1: Update `src/pages/index.astro` imports**

Replace these import lines (currently 6-11):

```ts
import TopicRow from '@/components/TopicRow.astro';
import { getCategories, getCategory, GOVERNANCE_CATEGORY_SLUG } from '../../config/categories.js';
import { getCategoryStats, getLatestTopicsAcrossCategories } from '@/lib/db/forum.js';
import { getGovernanceActionsByTopicIds, getLatestGovernanceAction } from '@/lib/db/governance.js';
import { loadAuthorIdentities } from '@/lib/forum/author.js';
import { readableType, statusBadge, TONE_COLORS } from '@/lib/governance/view.js';
```

with:

```ts
import ActivityRow from '@/components/ActivityRow.astro';
import { getCategories } from '../../config/categories.js';
import { getCategoryStats } from '@/lib/db/forum.js';
import { getLatestGovernanceAction } from '@/lib/db/governance.js';
import { loadActivityFeed } from '@/lib/forum/activityFeed.js';
import { readableType, statusBadge, TONE_COLORS } from '@/lib/governance/view.js';
```

- [ ] **Step 2: Replace the data-loading block in `src/pages/index.astro`**

Replace the block (currently lines 19-38) that loads `[stats, latest, heroAction]` and then `[identities, govByTopic]`:

```ts
// Category stats, the latest 4 topics, and the hero's newest governance action
// are independent; load them together.
const [stats, latest, heroAction] = db
  ? await Promise.all([
      getCategoryStats(db),
      getLatestTopicsAcrossCategories(db, { limit: 4 }),
      getLatestGovernanceAction(db),
    ])
  : [new Map<string, { topicCount: number; lastPostAt: number | null }>(), [], null];

// Author identities and governance actions depend only on `latest`.
const govTopicIds = latest
  .filter((t) => t.category_slug === GOVERNANCE_CATEGORY_SLUG)
  .map((t) => t.id);
const [identities, govByTopic] = await Promise.all([
  db ? loadAuthorIdentities(db, latest.map((t) => t.author_id)) : Promise.resolve(null),
  db && govTopicIds.length
    ? getGovernanceActionsByTopicIds(db, govTopicIds)
    : Promise.resolve(new Map()),
]);
```

with:

```ts
// Category stats, the latest activity feed, and the hero's newest governance
// action are independent; load them together.
const [stats, feed, heroAction] = db
  ? await Promise.all([
      getCategoryStats(db),
      loadActivityFeed(db, { limit: 6 }),
      getLatestGovernanceAction(db),
    ])
  : [new Map<string, { topicCount: number; lastPostAt: number | null }>(), [], null];
```

- [ ] **Step 3: Replace the "Latest activity" render block in `src/pages/index.astro`**

Replace the block (currently lines 246-266):

```astro
      <section aria-label="Latest activity">
        <h3 class="section-label">Latest activity</h3>
        {latest.length === 0 ? (
          <p style="color:var(--muted);">No topics yet.</p>
        ) : (
          <div>
            {latest.map((t) => (
              <TopicRow
                topic={t}
                now={now}
                author={identities ? identities.describe(t.author_id) : undefined}
                category={getCategory(t.category_slug)}
                governance={govByTopic.get(t.id)}
              />
            ))}
          </div>
        )}
        <div class="view-all-row">
          <a class="view-all-link" href="/discussions">View all discussions</a>
        </div>
      </section>
```

with:

```astro
      <section aria-label="Latest activity">
        <h3 class="section-label">Latest activity</h3>
        {feed.length === 0 ? (
          <p style="color:var(--muted);">No recent activity yet.</p>
        ) : (
          <div>
            {feed.map((e) => (
              <ActivityRow event={e} now={now} />
            ))}
          </div>
        )}
        <div class="view-all-row">
          <a class="view-all-link" href="/discussions">View all discussions</a>
        </div>
      </section>
```

- [ ] **Step 4: Update `src/pages/discussions.astro` imports**

Replace these import lines (currently 6-10):

```ts
import TopicRow from '@/components/TopicRow.astro';
import { getLatestTopicsAcrossCategories, getCategoryStats } from '@/lib/db/forum.js';
import { getGovernanceActionsByTopicIds } from '@/lib/db/governance.js';
import { loadAuthorIdentities } from '@/lib/forum/author.js';
import { getCategories, getCategory, GOVERNANCE_CATEGORY_SLUG } from '../../config/categories.js';
```

with:

```ts
import ActivityRow from '@/components/ActivityRow.astro';
import { getCategoryStats } from '@/lib/db/forum.js';
import { loadActivityFeed } from '@/lib/forum/activityFeed.js';
import { getCategories } from '../../config/categories.js';
```

- [ ] **Step 5: Replace the data-loading block in `src/pages/discussions.astro`**

Replace the block (currently lines 19-30):

```ts
// Category stats and the latest-topics list are independent; load them together.
const [stats, latest] = db
  ? await Promise.all([getCategoryStats(db), getLatestTopicsAcrossCategories(db, { limit: 20 })])
  : [new Map<string, { topicCount: number; lastPostAt: number | null }>(), []];

// Then the author identities and the governance actions for the listed topics,
// both depending only on `latest` and independent of each other (one query each).
const govTopicIds = latest.filter((t) => t.category_slug === GOVERNANCE_CATEGORY_SLUG).map((t) => t.id);
const [identities, govByTopic] = await Promise.all([
  db ? loadAuthorIdentities(db, latest.map((t) => t.author_id)) : Promise.resolve(null),
  db && govTopicIds.length ? getGovernanceActionsByTopicIds(db, govTopicIds) : Promise.resolve(new Map()),
]);
```

with:

```ts
// Category stats and the latest activity feed are independent; load them together.
const [stats, feed] = db
  ? await Promise.all([getCategoryStats(db), loadActivityFeed(db, { limit: 30 })])
  : [new Map<string, { topicCount: number; lastPostAt: number | null }>(), []];
```

- [ ] **Step 6: Replace the "Latest activity" render block in `src/pages/discussions.astro`**

Replace the block (currently lines 73-90):

```astro
    <section aria-label="Latest activity">
      <h2 style="font-size:0.8125rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin:0 0 0.75rem;">Latest activity</h2>
      {latest.length === 0 ? (
        <p style="color:var(--muted);">No topics yet.</p>
      ) : (
        <div>
          {latest.map((t) => (
            <TopicRow
              topic={t}
              now={now}
              author={identities ? identities.describe(t.author_id) : undefined}
              category={getCategory(t.category_slug)}
              governance={govByTopic.get(t.id)}
            />
          ))}
        </div>
      )}
    </section>
```

with:

```astro
    <section aria-label="Latest activity">
      <h2 style="font-size:0.8125rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin:0 0 0.75rem;">Latest activity</h2>
      {feed.length === 0 ? (
        <p style="color:var(--muted);">No recent activity yet.</p>
      ) : (
        <div>
          {feed.map((e) => (
            <ActivityRow event={e} now={now} />
          ))}
        </div>
      )}
    </section>
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors. (Catches any unused import left behind, a wrong relative path, or a prop mismatch. If `astro check` flags an unused `now`/`formatRelativeTime` in a page, remove only the genuinely unused symbol; `formatRelativeTime` and `now` are still used by the category column on both pages, so keep them.)

- [ ] **Step 8: Commit**

```bash
git add src/pages/index.astro src/pages/discussions.astro
git commit -m "feat: show the activity feed on the homepage and discussions"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS (all node and workers tests).

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both PASS with no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Manual smoke (local, preprod data)**

Run: `npm run preview` (builds, then serves via wrangler dev). Open the homepage and `/discussions`. Confirm the "Latest activity" column shows event lines (actor or system icon, verb, linked title, time), governance events show a status badge, and reply lines link to the post anchor. The category navigation column is unchanged.

Note: the feed reads from the `activity` table. On a local D1 that has never run the 0030 backfill, apply migrations first: `npm run db:migrate:local`. If the local DB has topics/posts from before, the backfill populates the feed; otherwise create a topic and a reply through the UI to see live events.

- [ ] **Step 5: No commit** (verification only). Stop here and report status; do not push or open a PR (the user tests first and gives an explicit go-ahead).

---

## Self-Review (completed by the plan author)

**Spec coverage:**
- Section A (table) -> Task 1. Section B (emission, 4 sites) -> Tasks 3, 4, 5. Section C (backfill) -> Task 1. Section D (read + hydration) -> Tasks 2, 6. Section E (view model) -> Task 6. Section F (rendering) -> Task 7. Section G (wiring) -> Task 8. Section H (tests) -> Tasks 2-7 (each behavior has a test). Final build/lint -> Task 9. All spec sections map to a task.
- Spec "non goals" honored: no bundling (one row per event), category nav untouched, no new cron, `getLatestTopicsAcrossCategories` left in place (Task 8 stops importing it on these two pages but does not delete it).

**Type consistency:** `activityInsert` / `getRecentActivity` / `ActivityRow` / `ActivityKind` (Task 2) are used unchanged in Tasks 3-6. `ActivityEvent` (Task 6) is consumed by `ActivityRow.astro` (Task 7) and the pages (Task 8) with matching field names (`kind`, `actor`, `topic.{title,slug,categoryName,isGovernance}`, `governanceStatus`, `statusTransition`, `refPostId`, `createdAt`). `govStatusVerb` (Task 7) signature matches its call in the component.

**Placeholder scan:** no TBD/TODO; every code step shows complete content; commands list expected output.
