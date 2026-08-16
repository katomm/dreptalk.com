// src/lib/db/postErasure.workers.test.ts
// The erasure primitive. Runs in real workerd so the FTS triggers from
// migration 0019 fire exactly as they do in production: the search assertions
// below are the only proof that blanking body_md really clears the index.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost } from './forum.js';
import { erasePostContent } from './postErasure.js';

const db = () => env.DB;
const T = 1_700_000_000_000;
const AUTHOR = 'test-author-erasure';

// A token that appears in no other fixture in the suite, so an FTS hit can only
// come from this post.
const RARE = 'quokkaturbine';

async function seedTopic(suffix: string, body = `hello ${RARE}`) {
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: AUTHOR, title: `Erasure ${suffix}`,
    bodyMd: body, bodyHtml: `<p>${body}</p>`, now: T, rand: suffix,
  });
  return { topicId: topic.id, postId: firstPost.id };
}

async function seedRevision(postId: string, suffix: string) {
  await db()
    .prepare(
      `INSERT INTO post_revisions (id, post_id, body_md, body_html, replaced_at, editor_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(`rev-${suffix}`, postId, `old ${RARE}`, `<p>old ${RARE}</p>`, T, AUTHOR)
    .run();
}

async function seedDoc(postId: string, topicId: string, hash: string) {
  await db()
    .prepare(
      `INSERT INTO cip100_docs (hash, body, post_id, topic_id, version, prev_hash, source_edited_at, created_at)
       VALUES (?, ?, ?, ?, 1, NULL, NULL, ?)`,
    )
    .bind(hash, `{"comment":"${RARE}"}`, postId, topicId, T)
    .run();
}

async function ftsHits(postId: string): Promise<number> {
  const res = await db()
    .prepare(
      `SELECT COUNT(*) AS n FROM posts_fts
         JOIN posts p ON p.rowid = posts_fts.rowid
        WHERE posts_fts MATCH ?1 AND p.id = ?2`,
    )
    .bind(RARE, postId)
    .first<{ n: number }>();
  return res?.n ?? 0;
}

async function bodyOf(postId: string) {
  return db()
    .prepare('SELECT body_md, body_html FROM posts WHERE id = ?')
    .bind(postId)
    .first<{ body_md: string; body_html: string }>();
}

describe('erasePostContent', () => {
  it('erases bodies, revisions, documents and the search index in one call', async () => {
    const { topicId, postId } = await seedTopic('e1');
    await seedRevision(postId, 'e1');
    await seedDoc(postId, topicId, 'a'.repeat(64));
    expect(await ftsHits(postId)).toBe(1);

    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T, postId).run();
    const res = await erasePostContent(db(), postId, { now: T, cutoff: T });

    expect(res).toEqual({ bodies: 1, revisions: 1, docs: 1 });
    expect(await bodyOf(postId)).toEqual({ body_md: '', body_html: '' });
    expect(await ftsHits(postId)).toBe(0);
    const revs = await db()
      .prepare('SELECT COUNT(*) AS n FROM post_revisions WHERE post_id = ?')
      .bind(postId).first<{ n: number }>();
    expect(revs?.n).toBe(0);
    const doc = await db()
      .prepare('SELECT body FROM cip100_docs WHERE post_id = ?')
      .bind(postId).first<{ body: string | null }>();
    expect(doc?.body).toBeNull();
  });

  it('is idempotent and writes no rows on a second call', async () => {
    const { topicId, postId } = await seedTopic('e2');
    await seedRevision(postId, 'e2');
    await seedDoc(postId, topicId, 'b'.repeat(64));
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T, postId).run();

    await erasePostContent(db(), postId, { now: T, cutoff: T });
    expect(await erasePostContent(db(), postId, { now: T, cutoff: T })).toEqual({ bodies: 0, revisions: 0, docs: 0 });
  });

  // The guard has to cover both flags. A live post inside a deleted thread is
  // just as unreachable as a deleted post, and getDocForServe already calls
  // both states 'gone'.
  it('erases a live post inside a deleted topic', async () => {
    const { topicId, postId } = await seedTopic('e3');
    await seedRevision(postId, 'e3');
    await db().prepare('UPDATE topics SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T, topicId).run();

    const res = await erasePostContent(db(), postId, { now: T, cutoff: T });
    expect(res.bodies).toBe(1);
    expect(res.revisions).toBe(1);
    expect(await ftsHits(postId)).toBe(0);
  });

  // upsertVoteRationalePost revives a soft-deleted cross-post back to
  // deleted = 0. If that lands between candidate selection and this batch, the
  // post must come out whole, not half erased.
  it('leaves a post that is neither deleted nor in a deleted topic completely alone', async () => {
    const { topicId, postId } = await seedTopic('e4');
    await seedRevision(postId, 'e4');
    await seedDoc(postId, topicId, 'c'.repeat(64));

    expect(await erasePostContent(db(), postId, { now: T, cutoff: T })).toEqual({ bodies: 0, revisions: 0, docs: 0 });
    expect((await bodyOf(postId))?.body_md).toContain(RARE);
    expect(await ftsHits(postId)).toBe(1);
    const revs = await db()
      .prepare('SELECT COUNT(*) AS n FROM post_revisions WHERE post_id = ?')
      .bind(postId).first<{ n: number }>();
    expect(revs?.n).toBe(1);
  });

  // Hiding is reversible and answers 404. Erasing a hidden post would make a
  // withdrawn flag unrecoverable.
  it('leaves a hidden but undeleted post alone', async () => {
    const { topicId, postId } = await seedTopic('e5');
    await seedDoc(postId, topicId, 'd'.repeat(64));
    await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(postId).run();

    expect(await erasePostContent(db(), postId, { now: T, cutoff: T })).toEqual({ bodies: 0, revisions: 0, docs: 0 });
    expect(await ftsHits(postId)).toBe(1);
  });

  it('erases a reply as well as an opening post', async () => {
    const { topicId } = await seedTopic('e6', 'opening text');
    const reply = await createPost(db(), {
      topicId, authorId: AUTHOR, bodyMd: `reply ${RARE}`, bodyHtml: `<p>reply ${RARE}</p>`, now: T + 1,
    });
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T, reply.id).run();

    expect((await erasePostContent(db(), reply.id, { now: T, cutoff: T })).bodies).toBe(1);
    expect(await ftsHits(reply.id)).toBe(0);
  });

  // The sweep selects in one D1 call and erases in another. Between them a
  // cross-post can be revived and deleted again, which resets its clock. This is
  // the state the batch has to refuse, and the reason the cutoff is inside the
  // guard rather than only in the candidate query.
  it('refuses to erase a deletion newer than the cutoff', async () => {
    const { postId } = await seedTopic('e7');
    // Deleted just now, while the caller is working to a cutoff 30 days back.
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T, postId).run();

    const res = await erasePostContent(db(), postId, { now: T, cutoff: T - 30 * 24 * 60 * 60 * 1000 });
    expect(res).toEqual({ bodies: 0, revisions: 0, docs: 0 });
    expect(await ftsHits(postId)).toBe(1);
  });

  // Same rule on the thread clock: a thread deleted today does not become
  // erasable because one of its posts was deleted long ago.
  it('refuses a thread deletion newer than the cutoff', async () => {
    const { topicId, postId } = await seedTopic('e8');
    await db().prepare('UPDATE topics SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T, topicId).run();

    const res = await erasePostContent(db(), postId, { now: T, cutoff: T - 1 });
    expect(res).toEqual({ bodies: 0, revisions: 0, docs: 0 });
  });

  // A deletion with no known date is erased by no cutoff at all, including the
  // immediate one. Guessing a date is what the retention decision exists to
  // avoid.
  it('never erases a deletion that carries no timestamp', async () => {
    const { postId } = await seedTopic('e9');
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = NULL WHERE id = ?').bind(postId).run();

    expect(await erasePostContent(db(), postId, { now: T, cutoff: T })).toEqual({
      bodies: 0, revisions: 0, docs: 0,
    });
  });
});

import { runPostErasureSweep, POST_ERASURE_RETENTION_MS } from './postErasure.js';

const DAY = 24 * 60 * 60 * 1000;

describe('runPostErasureSweep', () => {
  it('leaves a post deleted 29 days ago and erases one deleted 31 days ago', async () => {
    const young = await seedTopic('s1');
    const old = await seedTopic('s2');
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?')
      .bind(T - 29 * DAY, young.postId).run();
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?')
      .bind(T - 31 * DAY, old.postId).run();

    const res = await runPostErasureSweep(db(), { now: T, limit: 50 });

    expect(res.erased).toBe(1);
    expect(await ftsHits(old.postId)).toBe(0);
    expect(await ftsHits(young.postId)).toBe(1);
  });

  // The window is 30 days and the constant is the only definition of it.
  it('uses POST_ERASURE_RETENTION_MS as the default window', async () => {
    const { postId } = await seedTopic('s3');
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?')
      .bind(T - POST_ERASURE_RETENTION_MS - 1, postId).run();

    expect((await runPostErasureSweep(db(), { now: T, limit: 50 })).erased).toBe(1);
  });

  it('erases a post in a deleted topic on the topic clock, not the post clock', async () => {
    const { topicId, postId } = await seedTopic('s4');
    await db().prepare('UPDATE topics SET deleted = 1, deleted_at = ? WHERE id = ?')
      .bind(T - 31 * DAY, topicId).run();

    expect((await runPostErasureSweep(db(), { now: T, limit: 50 })).erased).toBe(1);
    expect(await ftsHits(postId)).toBe(0);
  });

  // A deletion typed by hand carries no timestamp. The sweep stamps it, which
  // starts its window now, so it is erasable one full window later and never in
  // the same run.
  it('stamps an unstamped deletion, does not erase it in the same run, and erases it after the window', async () => {
    const { postId } = await seedTopic('s5');
    await db().prepare('UPDATE posts SET deleted = 1 WHERE id = ?').bind(postId).run();

    const first = await runPostErasureSweep(db(), { now: T, limit: 50 });
    expect(first.stamped).toBeGreaterThan(0);
    expect(first.erased).toBe(0);
    expect(await ftsHits(postId)).toBe(1);

    const stamp = await db().prepare('SELECT deleted_at FROM posts WHERE id = ?')
      .bind(postId).first<{ deleted_at: number }>();
    expect(stamp?.deleted_at).toBe(T);

    const later = await runPostErasureSweep(db(), { now: T + 31 * DAY, limit: 50 });
    expect(later.erased).toBe(1);
    expect(await ftsHits(postId)).toBe(0);
  });

  // deleted_at is not authoritative on a row whose flag is not set. A revived
  // cross-post keeps its old timestamp today, so reading it through a COALESCE
  // would let a thread deleted this morning erase its posts at once.
  it('ignores a stale deleted_at on a post that is no longer deleted', async () => {
    const { topicId, postId } = await seedTopic('s6');
    // Deleted long ago, then revived: flag cleared, timestamp left behind.
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?')
      .bind(T - 400 * DAY, postId).run();
    await db().prepare('UPDATE posts SET deleted = 0 WHERE id = ?').bind(postId).run();
    // Now the thread is deleted, today.
    await db().prepare('UPDATE topics SET deleted = 1, deleted_at = ? WHERE id = ?')
      .bind(T, topicId).run();

    expect((await runPostErasureSweep(db(), { now: T, limit: 50 })).erased).toBe(0);
    expect(await ftsHits(postId)).toBe(1);

    // And it does become erasable a window after the thread deletion.
    expect((await runPostErasureSweep(db(), { now: T + 31 * DAY, limit: 50 })).erased).toBe(1);
  });

  // The topic half of stampMissingDeletedAt has no other test now that the cron
  // test covering it has moved. Without this, that statement could be dropped
  // and nothing would go red.
  it('stamps a manually deleted topic and erases its posts a window later', async () => {
    const { topicId, postId } = await seedTopic('s5b');
    await db().prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(topicId).run();

    const first = await runPostErasureSweep(db(), { now: T, limit: 50 });
    expect(first.erased).toBe(0);
    const stamp = await db().prepare('SELECT deleted_at FROM topics WHERE id = ?')
      .bind(topicId).first<{ deleted_at: number }>();
    expect(stamp?.deleted_at).toBe(T);
    expect(await ftsHits(postId)).toBe(1);

    expect((await runPostErasureSweep(db(), { now: T + 31 * DAY, limit: 50 })).erased).toBe(1);
    expect(await ftsHits(postId)).toBe(0);
  });

  it('respects the limit and reports the remaining backlog', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { postId } = await seedTopic(`s7${i}`);
      await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?')
        .bind(T - 31 * DAY, postId).run();
      ids.push(postId);
    }

    const first = await runPostErasureSweep(db(), { now: T, limit: 2 });
    expect(first.erased).toBe(2);
    expect(first.remaining).toBe(1);

    const second = await runPostErasureSweep(db(), { now: T, limit: 2 });
    expect(second.erased).toBe(1);
    expect(second.remaining).toBe(0);
  });

  it('does not select an already erased post again', async () => {
    const { postId } = await seedTopic('s8');
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?')
      .bind(T - 31 * DAY, postId).run();

    expect((await runPostErasureSweep(db(), { now: T, limit: 50 })).erased).toBe(1);
    const again = await runPostErasureSweep(db(), { now: T, limit: 50 });
    expect(again.erased).toBe(0);
    expect(again.remaining).toBe(0);
  });

  it('leaves a hidden but undeleted post out of the sweep entirely', async () => {
    const { postId } = await seedTopic('s9');
    await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(postId).run();

    expect((await runPostErasureSweep(db(), { now: T + 400 * DAY, limit: 50 })).erased).toBe(0);
    expect(await ftsHits(postId)).toBe(1);
  });

  it('ships the partial indexes the sweep is written for', async () => {
    const rows = await db()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?)`)
      .bind('idx_posts_deleted_sweep', 'idx_topics_deleted_sweep')
      .all<{ name: string }>();
    expect((rows.results ?? []).map((r) => r.name).sort()).toEqual([
      'idx_posts_deleted_sweep',
      'idx_topics_deleted_sweep',
    ]);
  });
});
