// src/lib/db/cip100.workers.test.ts
// Store access for emitted CIP-100 documents. Runs in real workerd so the
// UNIQUE constraint and the deletion joins behave exactly as in production.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from './forum.js';
import {
  getDocForServe, getHeadDoc, insertDoc, touchSourceEditedAt,
  listPostVersions, purgeDeletedDocs, findStalePostIds,
} from './cip100.js';

const db = () => env.DB;
const T = 1_700_000_000_000;
const AUTHOR = 'test-author-cip100';

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
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T,
    });
    expect(ok).toBe('inserted');
    const served = await getDocForServe(db(), 'a'.repeat(64));
    expect(served).toEqual({ body: '{"x":1}', gone: false });
    expect((await getHeadDoc(db(), postId))?.version).toBe(1);
  });

  it('reports a duplicate hash as unchanged, not as a conflict', async () => {
    const { topicId, postId } = await seedPost('a2');
    const rec = {
      hash: 'b'.repeat(64), body: '{"x":2}', postId, topicId,
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T,
    };
    expect(await insertDoc(db(), rec)).toBe('inserted');
    expect(await insertDoc(db(), rec)).toBe('duplicate');
  });

  it('reports a version collision as a conflict', async () => {
    const { topicId, postId } = await seedPost('a3');
    const base = { postId, topicId, version: 1, prevHash: null, sourceEditedAt: null, createdAt: T };
    expect(await insertDoc(db(), { ...base, hash: 'c'.repeat(64), body: '{"x":3}' })).toBe('inserted');
    expect(await insertDoc(db(), { ...base, hash: 'd'.repeat(64), body: '{"x":4}' })).toBe('conflict');
  });

  it('serves gone for a deleted post and purges its bytes', async () => {
    const { topicId, postId } = await seedPost('a4');
    await insertDoc(db(), {
      hash: 'e'.repeat(64), body: '{"x":5}', postId, topicId,
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T,
    });
    await db().prepare('UPDATE posts SET deleted = 1, deleted_at = ? WHERE id = ?').bind(T, postId).run();
    expect(await getDocForServe(db(), 'e'.repeat(64))).toEqual({ body: '{"x":5}', gone: true });
    expect(await purgeDeletedDocs(db(), T)).toBe(1);
    expect(await getDocForServe(db(), 'e'.repeat(64))).toEqual({ body: null, gone: true });
  });

  it('finds a post whose head is behind the post', async () => {
    const { topicId, postId } = await seedPost('a5');
    await insertDoc(db(), {
      hash: 'f'.repeat(64), body: '{"x":6}', postId, topicId,
      version: 1, prevHash: null, sourceEditedAt: null, createdAt: T,
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
        sourceEditedAt: null, createdAt: T + i,
      });
    }
    expect((await listPostVersions(db(), postId)).map((v) => v.version)).toEqual([1, 2]);
  });
});
