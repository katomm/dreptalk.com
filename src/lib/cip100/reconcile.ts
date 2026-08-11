/// <reference types="@cloudflare/workers-types" />
// src/lib/cip100/reconcile.ts
// The single writer to cip100_docs. Idempotent by construction: it computes the
// document the post's current state deserves and only writes when that differs
// from what is stored. Both callers (the edit handler and the cron) run exactly
// this function, so there is one definition of what a post's documents are.
import { loadAuthorIdentity } from '../forum/author.js';
import { isWithinGrace } from '../forum/editPolicy.js';
import { getDocBody, getHeadDoc, insertDoc, touchSourceEditedAt } from '../db/cip100.js';
import { buildDiscussionPostDoc } from './document.js';
import type { Cip100Network } from './origin.js';

export interface ReconcileOptions {
  origin: string;
  network: Cip100Network;
  now: number;
}

export interface ReconcileResult {
  status: 'created' | 'unchanged' | 'skipped' | 'conflict';
  hash?: string;
}

interface PostRow {
  id: string;
  topic_id: string;
  author_id: string;
  body_md: string;
  parent_post_id: string | null;
  created_at: number;
  edited_at: number | null;
  deleted: number;
  source: string | null;
  topic_slug: string;
  topic_source: string;
  topic_deleted: number;
  proposal_id: string | null;
  opening_post_id: string | null;
}

async function loadPost(db: D1Database, postId: string): Promise<PostRow | null> {
  return db
    .prepare(
      `SELECT p.id, p.topic_id, p.author_id, p.body_md, p.parent_post_id, p.created_at,
              p.edited_at, p.deleted, p.source,
              t.slug AS topic_slug, t.source AS topic_source, t.deleted AS topic_deleted,
              (SELECT proposal_id FROM governance_actions WHERE topic_id = t.id) AS proposal_id,
              (SELECT id FROM posts WHERE topic_id = t.id AND parent_post_id IS NULL
                ORDER BY created_at ASC LIMIT 1) AS opening_post_id
         FROM posts p
         JOIN topics t ON t.id = p.topic_id
        WHERE p.id = ?`,
    )
    .bind(postId)
    .first<PostRow>();
}

/** The scope rule from spec section 3, in one place so the cron query and the
 *  request path can never disagree about what is emitted. */
function outOfScope(post: PostRow, now: number): boolean {
  if (post.deleted === 1 || post.topic_deleted === 1) return true;
  // Vote rationale cross-posts reference the existing /vote-rationale/ document.
  if (post.source === 'vote_rationale') return true;
  // The opening post of a governance topic mirrors on-chain content that
  // already has its own CIP-108 anchor.
  if (post.topic_source === 'governance' && post.opening_post_id === post.id) return true;
  // Inside the grace window edits are silent and leave no trace in edited_at,
  // so no document may exist yet. See spec section 10.2.
  return isWithinGrace(post.created_at, now);
}

export async function reconcilePostDocs(
  db: D1Database,
  postId: string,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const post = await loadPost(db, postId);
  if (!post || outOfScope(post, opts.now)) return { status: 'skipped' };

  const author = await loadAuthorIdentity(db, post.author_id);
  // Profile links use the id form, not the slug form the UI prefers: slugs can
  // be added or changed later, ids cannot, and the id URL always resolves (the
  // profile route 301s to the canonical one). Immutable bytes take the stable
  // form. Authors without a DRep or pool (CC members, delegators) get no
  // profile field at all.
  const profile = author.drepId
    ? `${opts.origin}/dreps/${author.drepId}/`
    : author.poolId
      ? `${opts.origin}/spos/${author.poolId}/`
      : null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const head = await getHeadDoc(db, postId);

    // A reply points at the parent's head as it exists now, which for a live
    // emit is the version that was replied to. A backfill cannot know the
    // historical one, and getHeadDoc then returns today's head, so only use it
    // when this post has no document yet AND the parent's head predates the
    // reply. Otherwise omit it and let inReplyToPostId carry the structure.
    let parentDocHash: string | null = null;
    if (post.parent_post_id) {
      const parentHead = await getHeadDoc(db, post.parent_post_id);
      if (parentHead && parentHead.createdAt <= post.created_at) parentDocHash = parentHead.hash;
    }

    const built = buildDiscussionPostDoc({
      origin: opts.origin,
      network: opts.network,
      postId: post.id,
      topicId: post.topic_id,
      topicSlug: post.topic_slug,
      version: (head?.version ?? 0) + 1,
      postedAt: post.created_at,
      revisedAt: post.edited_at,
      governanceActionId: post.proposal_id,
      parentPostId: post.parent_post_id,
      parentDocHash,
      prevHash: head?.hash ?? null,
      postedBy: {
        handle: author.displayName,
        profile,
        drepId: author.drepId ?? null,
        poolId: author.poolId ?? null,
      },
      comment: post.body_md,
    });

    // The no-op edit rule: editPost stamps edited_at even when the submitted
    // text is identical, so compare the content itself. Without this, every
    // such edit would publish a version whose only difference is its own
    // version metadata.
    if (head) {
      const storedBody = await getDocBody(db, head.hash);
      if (storedBody) {
        const stored = JSON.parse(storedBody) as { body?: { comment?: string } };
        if (stored.body?.comment === post.body_md) {
          // Record that this edit was seen, or the cron would find the post
          // stale on every run for the rest of time.
          await touchSourceEditedAt(db, head.hash, post.edited_at);
          return { status: 'unchanged', hash: head.hash };
        }
      }
    }

    const result = await insertDoc(db, {
      hash: built.hash,
      body: built.body,
      postId: post.id,
      topicId: post.topic_id,
      version: (head?.version ?? 0) + 1,
      prevHash: head?.hash ?? null,
      sourceEditedAt: post.edited_at,
      createdAt: opts.now,
    });
    if (result === 'inserted') return { status: 'created', hash: built.hash };
    if (result === 'duplicate') return { status: 'unchanged', hash: built.hash };
    // 'conflict': another writer took this version number. Loop once to rebuild
    // against the new head, then leave it to the next cron run.
  }
  return { status: 'conflict' };
}
