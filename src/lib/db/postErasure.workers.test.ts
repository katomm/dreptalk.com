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
