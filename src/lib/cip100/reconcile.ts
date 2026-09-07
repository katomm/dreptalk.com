/// <reference types="@cloudflare/workers-types" />
// src/lib/cip100/reconcile.ts
// The single writer to cip100_docs. Idempotent by construction: it computes the
// document the post's current state deserves and only writes when that differs
// from what is stored. Both callers (the edit handler and the cron) run exactly
// this function, so there is one definition of what a post's documents are.
import { loadAuthorIdentity } from '../forum/author.js';
import { isWithinGrace } from '../forum/editPolicy.js';
import { getDocAtOrBefore, getDocBody, getHeadDoc, insertDoc, touchSourceEditedAt } from '../db/cip100.js';
import { buildDiscussionPostDoc } from './document.js';
import { authorProfileUrl, type Cip100Network } from './origin.js';

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
  hidden: number;
  source: string | null;
  topic_slug: string;
  topic_source: string;
  topic_deleted: number;
  topic_author_id: string;
  proposal_id: string | null;
}

async function loadPost(db: D1Database, postId: string): Promise<PostRow | null> {
  return db
    .prepare(
      `SELECT p.id, p.topic_id, p.author_id, p.body_md, p.parent_post_id, p.created_at,
              p.edited_at, p.deleted, p.hidden, p.source,
              t.slug AS topic_slug, t.source AS topic_source, t.deleted AS topic_deleted,
              t.author_id AS topic_author_id,
              (SELECT proposal_id FROM governance_actions WHERE topic_id = t.id) AS proposal_id
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
  // Hidden by community flags: the thread page replaces the body with a notice,
  // so publishing the same text to a permanent address would hand out exactly
  // what the forum withholds. Reversible, unlike deletion, so a post whose
  // flags are withdrawn becomes a candidate again on the next run.
  if (post.hidden === 1) return true;
  // Vote rationale cross-posts reference the existing /vote-rationale/ document.
  if (post.source === 'vote_rationale') return true;
  // The sync-generated mirror post of a synced topic reproduces on-chain
  // content that already has its own anchor — a CIP-108 anchor for a governance
  // action, a CIP-179 record for a survey. Identified by authorship, which is
  // exact: the sync writes the topic and its mirror post with the same author
  // id, and no human account holds that id. Identifying it as the oldest
  // top-level post was wrong, because a vote-rationale cross-post is back-dated
  // to its on-chain vote time and can therefore predate the mirror post. The
  // test is "not a user topic" rather than a list of synced kinds, so the next
  // kind cannot silently re-open this.
  if (post.topic_source !== 'user' && post.author_id === post.topic_author_id) return true;
  // Inside the grace window edits are silent and leave no trace in edited_at,
  // so no document may exist yet. See spec section 10.2.
  return isWithinGrace(post.created_at, now);
}

export async function reconcilePostDocs(
  db: D1Database,
  postId: string,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Reloaded on every attempt, not once before the loop. A conflict means
    // another writer just published a version, and the usual reason is an edit
    // that landed after this attempt read the post. Rebuilding from the stale
    // row would publish the OLD text as the newest version: the chain stays
    // linear, the content marches backwards, and the wrong snapshot is citable
    // forever. The scope check is repeated for the same reason, since the post
    // may have been deleted or hidden in the meantime.
    const post = await loadPost(db, postId);
    if (!post || outOfScope(post, opts.now)) return { status: 'skipped' };

    const author = await loadAuthorIdentity(db, post.author_id);
    const profile = authorProfileUrl(opts.origin, author);

    const head = await getHeadDoc(db, postId);
    const nextVersion = (head?.version ?? 0) + 1;
    const prevHash = head?.hash ?? null;

    // The no-op edit rule: editPost stamps edited_at even when the submitted
    // text is identical, so compare the content itself. Without this, every
    // such edit would publish a version whose only difference is its own
    // version metadata. Checked before building anything else, since the
    // common case (edited_at bumped, content unchanged) never needs a new
    // document at all.
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

    // A reply points at the parent version that was current when the reply
    // was written, looked up by time rather than by the parent's current
    // head. That is what makes the result deterministic: a later edit to the
    // parent, or to the reply itself, must not change what an earlier reply
    // version claims about the parent it was replying to. A null result is
    // the backfill case where the parent's only known snapshot postdates the
    // reply, and inReplyToPostId alone carries the structure.
    let parentDocHash: string | null = null;
    if (post.parent_post_id) {
      const parentDoc = await getDocAtOrBefore(db, post.parent_post_id, post.created_at);
      if (parentDoc) parentDocHash = parentDoc.hash;
    }

    const built = buildDiscussionPostDoc({
      origin: opts.origin,
      network: opts.network,
      postId: post.id,
      topicId: post.topic_id,
      topicSlug: post.topic_slug,
      version: nextVersion,
      postedAt: post.created_at,
      revisedAt: post.edited_at,
      governanceActionId: post.proposal_id,
      parentPostId: post.parent_post_id,
      parentDocHash,
      prevHash,
      postedBy: {
        handle: author.displayName,
        profile,
        drepId: author.drepId ?? null,
        poolId: author.poolId ?? null,
      },
      comment: post.body_md,
    });

    const result = await insertDoc(db, {
      hash: built.hash,
      body: built.body,
      postId: post.id,
      topicId: post.topic_id,
      version: nextVersion,
      prevHash,
      sourceEditedAt: post.edited_at,
      createdAt: opts.now,
      guard: { bodyMd: post.body_md, editedAt: post.edited_at },
    });
    if (result === 'inserted') return { status: 'created', hash: built.hash };
    if (result === 'duplicate') return { status: 'unchanged', hash: built.hash };
    // 'conflict': another writer took this version number.
    // 'stale': the post was edited while this document was being built.
    // Both mean the same thing here, loop once with freshly read state, then
    // leave it to the next cron run rather than spinning.
  }
  return { status: 'conflict' };
}
