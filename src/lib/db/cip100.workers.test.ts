// src/lib/db/cip100.workers.test.ts
// Store access for emitted CIP-100 documents. Runs in real workerd so the
// UNIQUE constraint and the deletion joins behave exactly as in production.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, createPost } from './forum.js';
import {
  getDocForServe, getHeadDoc, insertDoc, touchSourceEditedAt,
  listPostVersions, findStalePostIds, listPostIdsWithDocs,
} from './cip100.js';
import { erasePostContent } from './postErasure.js';

const db = () => env.DB;
const T = 1_700_000_000_000;
const AUTHOR = 'test-author-cip100';
// The insert is guarded against the post state it was built from. Seeded posts
// carry this body and no edit stamp, so every fixture below passes the guard.
const GUARD = { bodyMd: 'hello', editedAt: null };

async function seedPost(suffix: string) {
  const { topic, firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId: AUTHOR, title: `Doc store ${suffix}`,
    bodyMd: 'hello', bodyHtml: '<p>hello</p>', now: T, rand: suffix,
  });
  return { topicId: topic.id, postId: firstPost.id };
}

describe('cip100 store', () => {
  it('inserts a document and serves it back', async () => {
    const { topicId, postId } = await seedPost('a1');
    const ok = await insertDoc(db(), {
      hash: 'a'.repeat(64), body: '{"x":1}', postId, topicId,
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T, guard: GUARD,
    });
    expect(ok).toBe('inserted');
    const served = await getDocForServe(db(), 'a'.repeat(64));
    expect(served).toEqual({ body: '{"x":1}', state: 'available' });
    expect((await getHeadDoc(db(), postId))?.version).toBe(1);
  });

  it('reports a duplicate hash as unchanged, not as a conflict', async () => {
    const { topicId, postId } = await seedPost('a2');
    const rec = {
      hash: 'b'.repeat(64), body: '{"x":2}', postId, topicId,
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T, guard: GUARD,
    };
    expect(await insertDoc(db(), rec)).toBe('inserted');
    expect(await insertDoc(db(), rec)).toBe('duplicate');
  });

  // The guard is what stops a document built from a post state that has since
  // been edited from being written as the newest version. It cannot be repaired
  // afterwards, because a published snapshot is immutable.
  it('refuses an insert whose post no longer holds the text it was built from', async () => {
    const { topicId, postId } = await seedPost('a3b');
    const res = await insertDoc(db(), {
      hash: 'f'.repeat(64), body: '{"x":9}', postId, topicId,
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T,
      guard: { bodyMd: 'text this post no longer has', editedAt: null },
    });
    expect(res).toBe('stale');
    expect(await getHeadDoc(db(), postId)).toBeNull();
  });

  it('reports a version collision as a conflict', async () => {
    const { topicId, postId } = await seedPost('a3');
    const base = { postId, topicId, version: 1, prevHash: null, sourceEditedAt: null, createdAt: T, guard: GUARD };
    expect(await insertDoc(db(), { ...base, hash: 'c'.repeat(64), body: '{"x":3}' })).toBe('inserted');
    expect(await insertDoc(db(), { ...base, hash: 'd'.repeat(64), body: '{"x":4}' })).toBe('conflict');
  });

  it('serves gone for a deleted post and erases its bytes', async () => {
    const { topicId, postId } = await seedPost('a4');
    await insertDoc(db(), {
      hash: 'e'.repeat(64), body: '{"x":5}', postId, topicId,
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T, guard: GUARD,
    });
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T, postId).run();
    // Gone is derived from the live flag, so it is true before the bytes go.
    expect(await getDocForServe(db(), 'e'.repeat(64))).toEqual({ body: '{"x":5}', state: 'gone' });
    expect((await erasePostContent(db(), postId, { now: T, cutoff: T })).docs).toBe(1);
    expect(await getDocForServe(db(), 'e'.repeat(64))).toEqual({ body: null, state: 'gone' });
  });

  it('reports a hidden post as hidden, not gone, and keeps its bytes', async () => {
    const { topicId, postId } = await seedPost('a8');
    await insertDoc(db(), {
      hash: '9'.repeat(64), body: '{"x":8}', postId, topicId,
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T, guard: GUARD,
    });
    await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(postId).run();
    expect(await getDocForServe(db(), '9'.repeat(64))).toEqual({ body: '{"x":8}', state: 'hidden' });
    // Hiding is not an erasure: the erasure path must leave the bytes alone, or
    // withdrawing a flag could never restore the document.
    expect((await erasePostContent(db(), postId, { now: T, cutoff: T })).docs).toBe(0);
    // And it must not hold a slot in the reconcile batch while it is hidden.
    expect(await findStalePostIds(db(), T + 1, 10)).not.toContain(postId);
  });

  it('finds a post whose head is behind the post', async () => {
    const { topicId, postId } = await seedPost('a5');
    await insertDoc(db(), {
      hash: 'f'.repeat(64), body: '{"x":6}', postId, topicId,
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T, guard: GUARD,
    });
    expect(await findStalePostIds(db(), T + 1, 10)).not.toContain(postId);
    await db().prepare('UPDATE posts SET edited_at = ? WHERE id = ?').bind(T + 5000, postId).run();
    expect(await findStalePostIds(db(), T + 1, 10)).toContain(postId);
    await touchSourceEditedAt(db(), 'f'.repeat(64), T + 5000);
    expect(await findStalePostIds(db(), T + 1, 10)).not.toContain(postId);
  });

  it('lists versions in chain order', async () => {
    const { topicId, postId } = await seedPost('a6');
    for (const [i, h] of ['1', '2'].entries()) {
      await insertDoc(db(), {
        hash: h.repeat(64), body: `{"v":${i + 1}}`, postId, topicId,
        version: i + 1, prevHash: i === 0 ? null : '1'.repeat(64),
        sourceEditedAt: null, createdAt: T + i, guard: GUARD,
      });
    }
    expect((await listPostVersions(db(), postId)).map((v) => v.version)).toEqual([1, 2]);
  });

  it('lists only the post ids in a thread that have a document', async () => {
    const { topicId, postId: openingId } = await seedPost('a7');
    const reply = await createPost(db(), {
      topicId, authorId: AUTHOR, bodyMd: 'reply', bodyHtml: '<p>reply</p>', now: T,
    });
    await insertDoc(db(), {
      hash: 'g'.repeat(64), body: '{"x":7}', postId: openingId, topicId,
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T, guard: GUARD,
    });
    // The reply has no document yet (still in its grace window): it must be
    // absent from the set, never optimistically included.
    const ids = await listPostIdsWithDocs(db(), topicId);
    expect(ids.has(openingId)).toBe(true);
    expect(ids.has(reply.id)).toBe(false);
  });
});
