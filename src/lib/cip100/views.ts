/// <reference types="@cloudflare/workers-types" />
// src/lib/cip100/views.ts
// The two mutable documents: a post's version index and a thread's manifest.
// Both are built live from D1 on every request, which is what makes deletion
// propagate with no extra step: a flagged post loses its identity everywhere
// the moment the flag is set.
import { listPostVersions } from '../db/cip100.js';
import { extensionContextUrl } from './context.js';
import { isoSeconds } from './document.js';

export interface ViewResult {
  status: 200 | 404 | 410;
  body: string | null;
}

function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Minimal tombstone: post id, status, deletion time when known, version
 *  hashes. No author identity, no title, no residual content. */
function tombstone(postId: string, deletedAt: number | null, hashes: string[]): Record<string, unknown> {
  const t: Record<string, unknown> = { postId, status: 'deleted' };
  // Omitted rather than invented when the flag was set without a timestamp.
  // Checked against null, not truthiness: epoch zero is a real timestamp.
  if (deletedAt !== null) t.deletedAt = isoSeconds(deletedAt);
  t.versions = hashes;
  return t;
}

export async function buildVersionIndex(db: D1Database, postId: string, origin: string): Promise<ViewResult> {
  const post = await db
    .prepare(
      `SELECT p.id, p.deleted, p.deleted_at, t.slug AS topic_slug, t.id AS topic_id,
              t.deleted AS topic_deleted, t.deleted_at AS topic_deleted_at
         FROM posts p JOIN topics t ON t.id = p.topic_id WHERE p.id = ?`,
    )
    .bind(postId)
    .first<{
      id: string; deleted: number; deleted_at: number | null; topic_slug: string;
      topic_id: string; topic_deleted: number; topic_deleted_at: number | null;
    }>();
  if (!post) return { status: 404, body: null };

  const versions = await listPostVersions(db, postId);
  if (versions.length === 0) return { status: 404, body: null };

  const context = extensionContextUrl(origin);
  if (post.deleted === 1 || post.topic_deleted === 1) {
    const at = post.deleted_at ?? post.topic_deleted_at ?? null;
    return {
      status: 200,
      body: serialize({
        '@context': context,
        '@type': 'DiscussionPostVersions',
        ...tombstone(postId, at, versions.map((v) => v.hash)),
      }),
    };
  }

  return {
    status: 200,
    body: serialize({
      '@context': context,
      '@type': 'DiscussionPostVersions',
      postId,
      status: 'published',
      thread: `${origin}/cip100/topic/${post.topic_id}.json`,
      permalink: `${origin}/t/${post.topic_slug}/#post-${postId}`,
      current: versions[versions.length - 1].hash,
      versions: versions.map((v) => ({
        version: v.version,
        hash: v.hash,
        uri: `${origin}/cip100/${v.hash}.json`,
        createdAt: isoSeconds(v.createdAt),
      })),
    }),
  };
}
