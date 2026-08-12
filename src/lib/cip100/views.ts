/// <reference types="@cloudflare/workers-types" />
// src/lib/cip100/views.ts
// The two mutable documents: a post's version index and a thread's manifest.
// Both are built live from D1 on every request, which is what makes deletion
// propagate with no extra step: a flagged post loses its identity everywhere
// the moment the flag is set.
import { listPostVersions, listThreadDocs } from '../db/cip100.js';
import { loadAuthorIdentities } from '../forum/author.js';
import { extensionContextUrl } from './context.js';
import { isoSeconds } from './document.js';
import type { Cip100Network } from './origin.js';

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

/**
 * The thread manifest IS the DiscussionThread entity: mutable, stable URL,
 * carrying the post list and its tombstones. Flat, obvious keys come first and
 * @context is additive, so an explorer can read it without ever having heard of
 * JSON-LD. That is deliberate: one artifact serves both the display consumers
 * and the citation consumers, or we would end up building two.
 */
export async function buildThreadManifest(
  db: D1Database,
  topicId: string,
  origin: string,
  network: Cip100Network,
): Promise<ViewResult> {
  const topic = await db
    .prepare(
      `SELECT t.id, t.title, t.slug, t.created_at, t.deleted,
              (SELECT proposal_id FROM governance_actions WHERE topic_id = t.id) AS proposal_id
         FROM topics t WHERE t.id = ?`,
    )
    .bind(topicId)
    .first<{
      id: string; title: string; slug: string; created_at: number;
      deleted: number; proposal_id: string | null;
    }>();
  if (!topic) return { status: 404, body: null };
  if (topic.deleted === 1) return { status: 410, body: null };

  const docs = await listThreadDocs(db, topicId);
  const byPost = new Map<string, Array<{ hash: string; version: number }>>();
  for (const d of docs) {
    const list = byPost.get(d.postId) ?? [];
    list.push({ hash: d.hash, version: d.version });
    byPost.set(d.postId, list);
  }

  // Only posts that actually have a document appear. Listing an emitted-out-of
  // -scope post without a hash would imply a document that does not exist.
  const rows = byPost.size === 0
    ? []
    : (
        await db
          .prepare(
            `SELECT p.id, p.author_id, p.parent_post_id, p.created_at, p.edited_at,
                    p.deleted, p.deleted_at
               FROM posts p WHERE p.topic_id = ? ORDER BY p.created_at`,
          )
          .bind(topicId)
          .all<{
            id: string; author_id: string; parent_post_id: string | null; created_at: number;
            edited_at: number | null; deleted: number; deleted_at: number | null;
          }>()
      ).results ?? [];

  // One batched identity read for the whole thread, not one per post: a long
  // thread would otherwise issue hundreds of queries to render one manifest.
  const identities = await loadAuthorIdentities(
    db,
    rows.filter((r) => r.deleted !== 1 && byPost.has(r.id)).map((r) => r.author_id),
  );

  const posts: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const versions = byPost.get(row.id);
    if (!versions) continue;
    const hashes = versions.map((v) => v.hash);
    if (row.deleted === 1) {
      posts.push(tombstone(row.id, row.deleted_at, hashes));
      continue;
    }
    const author = identities.describe(row.author_id);
    const profile = author.drepId
      ? `${origin}/dreps/${author.drepId}/`
      : author.poolId
        ? `${origin}/spos/${author.poolId}/`
        : null;
    const postedBy: Record<string, string> = { handle: author.displayName };
    if (profile) postedBy.profile = profile;
    if (author.drepId) postedBy.drepId = author.drepId;
    if (author.poolId) postedBy.poolId = author.poolId;

    const entry: Record<string, unknown> = {
      postId: row.id,
      status: 'published',
      postedAt: isoSeconds(row.created_at),
    };
    // Checked against null, not truthiness: an edit timestamp of epoch zero
    // would be a real (if absurd) value and must not be silently dropped.
    if (row.edited_at !== null) entry.revisedAt = isoSeconds(row.edited_at);
    entry.permalink = `${origin}/t/${topic.slug}/#post-${row.id}`;
    entry.postedBy = postedBy;
    // The id form, not a URL: inside one manifest the id is the useful join
    // key. Inside a snapshot the term is inReplyTo and carries a snapshot URL.
    if (row.parent_post_id) entry.inReplyToPostId = row.parent_post_id;
    entry.current = hashes[hashes.length - 1];
    entry.uri = `${origin}/cip100/${hashes[hashes.length - 1]}.json`;
    entry.versions = hashes;
    posts.push(entry);
  }

  const doc: Record<string, unknown> = {
    '@context': extensionContextUrl(origin),
    '@type': 'DiscussionThread',
    topicId: topic.id,
    title: topic.title,
    discussion: `${origin}/t/${topic.slug}/`,
  };
  if (topic.proposal_id) doc.governanceActionId = topic.proposal_id;
  doc.createdAt = isoSeconds(topic.created_at);
  doc.network = network;
  doc.forum = `${origin}/`;
  doc.posts = posts;
  return { status: 200, body: serialize(doc) };
}
