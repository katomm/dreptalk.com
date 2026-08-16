/// <reference types="@cloudflare/workers-types" />
// src/lib/cip100/views.ts
// The two mutable documents: a post's version index and a thread's manifest.
// Both are built live from D1 on every request, which is what makes deletion
// propagate with no extra step: a flagged post loses its identity everywhere
// the moment the flag is set.
import { listPostVersions, listThreadDocs, loadPostedByClaims } from '../db/cip100.js';
import { earliestActiveDeletion } from '../db/postErasure.js';
import { EXTENSION_CONTEXT_URL } from './context.js';
import { isoSeconds } from './document.js';
import { postVersionsUrl, snapshotUrl, threadManifestUrl, type Cip100Network } from './origin.js';

export interface ViewResult {
  status: 200 | 404 | 410;
  body: string | null;
}

interface DocVersion {
  hash: string;
  version: number;
  createdAt: number;
}

/**
 * What the live post and topic flags say about one post's versions. Both the
 * JSON version index and the human citation page derive from this single read,
 * so the two surfaces can never disagree about whether a post is gone: a
 * flagged post loses its identity on both the moment the flag is set.
 */
type IndexState =
  // Unknown post, no documents, or hidden. One kind for all three on purpose:
  // both surfaces have to answer "not found" to hiding, so collapsing them here
  // enforces that rather than asking every caller to remember it.
  | { kind: 'absent' }
  | { kind: 'deleted'; deletedAt: number | null; versions: DocVersion[] }
  | { kind: 'published'; topicId: string; topicSlug: string; topicTitle: string; versions: DocVersion[] };

async function loadIndexState(db: D1Database, postId: string): Promise<IndexState> {
  // Two independent reads: the version list is keyed on postId alone, so it
  // does not wait on the flag row.
  const [post, versions] = await Promise.all([
    db
      .prepare(
        `SELECT p.id, p.deleted, p.deleted_at, p.hidden, t.slug AS topic_slug, t.id AS topic_id,
                t.title AS topic_title, t.deleted AS topic_deleted, t.deleted_at AS topic_deleted_at
           FROM posts p JOIN topics t ON t.id = p.topic_id WHERE p.id = ?`,
      )
      .bind(postId)
      .first<{
        id: string; deleted: number; deleted_at: number | null; hidden: number; topic_slug: string;
        topic_id: string; topic_title: string; topic_deleted: number; topic_deleted_at: number | null;
      }>(),
    listPostVersions(db, postId),
  ]);
  if (!post || versions.length === 0) return { kind: 'absent' };

  // Deletion is checked BEFORE hiding, matching getDocForServe: a post that is
  // both is gone, on all surfaces. A hidden post that is then deleted must
  // still publish its deletion record, or a consumer holding the citation would
  // be told "gone, stop asking" by the snapshot and "no such thing" here. The
  // tombstone carries no author identity and no content, so publishing it for a
  // post that was also hidden says nothing about moderation.
  if (post.deleted === 1 || post.topic_deleted === 1) {
    return {
      kind: 'deleted',
      deletedAt: earliestActiveDeletion(
        post.deleted === 1 ? post.deleted_at : null,
        post.topic_deleted === 1 ? post.topic_deleted_at : null,
      ),
      versions,
    };
  }
  // Hidden and not deleted: never the tombstone. A tombstone states a deletion,
  // and hiding is a different, reversible state. The version list was read
  // above but is dropped here, so a hidden post's hashes stay unpublished.
  if (post.hidden === 1) return { kind: 'absent' };

  return {
    kind: 'published',
    topicId: post.topic_id,
    topicSlug: post.topic_slug,
    topicTitle: post.topic_title,
    versions,
  };
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
  const state = await loadIndexState(db, postId);
  if (state.kind === 'absent') return { status: 404, body: null };

  if (state.kind === 'deleted') {
    return {
      status: 200,
      body: serialize({
        '@context': EXTENSION_CONTEXT_URL,
        '@type': 'DiscussionPostVersions',
        ...tombstone(postId, state.deletedAt, state.versions.map((v) => v.hash)),
      }),
    };
  }

  const { versions } = state;
  return {
    status: 200,
    body: serialize({
      '@context': EXTENSION_CONTEXT_URL,
      '@type': 'DiscussionPostVersions',
      postId,
      status: 'published',
      thread: threadManifestUrl(origin, state.topicId),
      permalink: `${origin}/t/${state.topicSlug}/#post-${postId}`,
      current: versions[versions.length - 1].hash,
      versions: versions.map((v) => ({
        version: v.version,
        hash: v.hash,
        uri: snapshotUrl(origin, v.hash),
        createdAt: isoSeconds(v.createdAt),
      })),
    }),
  };
}

/** One published version, as the citation page lists it. */
export interface CitationVersion {
  version: number;
  /** Permanent address of exactly these bytes. */
  uri: string;
  /** Emit time in epoch milliseconds, formatted for display by the page. */
  createdAt: number;
  /** The head, i.e. the version a reader citing the post today should link to.
   *  Decided here rather than left to the template to re-derive from ordering. */
  current: boolean;
}

/**
 * The same state the JSON version index publishes, shaped for the human page at
 * /cite/<postId>/. The statuses differ from the JSON on purpose: a deleted post
 * answers 410 here, because a page is asking a reader to look at something,
 * while the JSON answers 200 with a tombstone body that a mirroring consumer
 * has to be able to read.
 */
export type CitationView =
  | { status: 404 }
  | { status: 410; deletedAt: number | null; versionCount: number }
  | {
      status: 200;
      topicTitle: string;
      /** Site-relative link back to the post, not the absolute form the JSON
       *  publishes: a reader on preprod or a dev host stays on their own host. */
      permalink: string;
      /** The JSON version index this page is the readable form of. */
      indexUri: string;
      /** Author identity frozen into the head document, not resolved live, so
       *  the page and the documents it lists can never name different authors. */
      handle: string | null;
      profile: string | null;
      /** Newest first: the version a reader most likely wants to cite is on top. */
      versions: CitationVersion[];
    };

export async function buildCitationView(db: D1Database, postId: string, origin: string): Promise<CitationView> {
  const state = await loadIndexState(db, postId);
  if (state.kind === 'absent') return { status: 404 };
  if (state.kind === 'deleted') {
    return { status: 410, deletedAt: state.deletedAt, versionCount: state.versions.length };
  }

  const { versions } = state;
  const head = versions[versions.length - 1];
  // One read for the head document only, the same claim the thread manifest
  // shows. A published post always has document bytes (they are erased only
  // along the deletion path, which took the 410 branch above), but a missing
  // claim degrades to no attribution rather than to an error.
  const claim = (await loadPostedByClaims(db, [head.hash])).get(head.hash);

  return {
    status: 200,
    topicTitle: state.topicTitle,
    permalink: `/t/${state.topicSlug}/#post-${postId}`,
    indexUri: postVersionsUrl(origin, postId),
    handle: claim?.handle ?? null,
    profile: claim?.profile ?? null,
    versions: versions
      .map((v) => ({
        version: v.version,
        uri: snapshotUrl(origin, v.hash),
        createdAt: v.createdAt,
        current: v.hash === head.hash,
      }))
      .reverse(),
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
                    p.deleted, p.deleted_at, p.hidden
               FROM posts p WHERE p.topic_id = ? ORDER BY p.created_at`,
          )
          .bind(topicId)
          .all<{
            id: string; author_id: string; parent_post_id: string | null; created_at: number;
            edited_at: number | null; deleted: number; deleted_at: number | null; hidden: number;
          }>()
      ).results ?? [];

  // Identity comes from the documents themselves, not from a live profile read.
  // A snapshot freezes `postedBy` at emit time, so resolving it again here would
  // let the manifest and the snapshot it points at claim different authors for
  // the same post the moment somebody changes their display name. One batched
  // read of the head documents, never one per post.
  const heads = [...byPost.values()].map((v) => v[v.length - 1].hash);
  const claims = await loadPostedByClaims(db, heads);

  const posts: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const versions = byPost.get(row.id);
    if (!versions) continue;
    const hashes = versions.map((v) => v.hash);
    // Deletion is checked BEFORE hiding, matching getDocForServe and the
    // version index: a post that is both is gone, and its deletion record is
    // published like any other. The tombstone carries no author identity and no
    // content, so it says nothing about moderation.
    if (row.deleted === 1) {
      posts.push(tombstone(row.id, row.deleted_at, hashes));
      continue;
    }
    // Hidden and not deleted: omitted entirely, exactly like a post that was
    // never in scope. No tombstone, that would say "deleted" about a reversible
    // state, and listing the entry at all would republish the handle, profile
    // and permalink of a post the thread page withholds.
    if (row.hidden === 1) continue;
    const postedBy = claims.get(hashes[hashes.length - 1]);

    const entry: Record<string, unknown> = {
      postId: row.id,
      status: 'published',
      postedAt: isoSeconds(row.created_at),
    };
    // Checked against null, not truthiness: an edit timestamp of epoch zero
    // would be a real (if absurd) value and must not be silently dropped.
    if (row.edited_at !== null) entry.revisedAt = isoSeconds(row.edited_at);
    entry.permalink = `${origin}/t/${topic.slug}/#post-${row.id}`;
    if (postedBy) entry.postedBy = postedBy;
    // The id form, not a URL: inside one manifest the id is the useful join
    // key. Inside a snapshot the term is inReplyTo and carries a snapshot URL.
    if (row.parent_post_id) entry.inReplyToPostId = row.parent_post_id;
    entry.current = hashes[hashes.length - 1];
    entry.uri = snapshotUrl(origin, hashes[hashes.length - 1]);
    entry.versions = hashes;
    posts.push(entry);
  }

  const doc: Record<string, unknown> = {
    '@context': EXTENSION_CONTEXT_URL,
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
