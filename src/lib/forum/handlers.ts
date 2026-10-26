/// <reference types="@cloudflare/workers-types" />
// Testable handler functions for forum write operations.
// All I/O deps are injected; Astro routes are thin wrappers over these.

import { createTopic, createPost, getPostById, getPostPlacement, editPost, editTitle } from '../db/forum.js';
import { POST_BODY_MAX, maxPostBody } from './postLimits.js';
import { flagPost, unflagPost, type FlagState } from '../db/postFlags.js';
import { setReaction, clearReaction, isReaction, type ReactionState, type Reaction } from '../db/postReactions.js';
import { renderMarkdown, type MentionLink } from '../markdown.js';
import { getCategory, isDiscussion, PROPOSAL_DRAFTS_CATEGORY_SLUG } from '../../../config/categories.js';
import { checkRate } from '../rate.js';
import type { RateLimiter } from '../rateLimiterDO.js';
import { isWriter, isModerator, canJudgePosts, WRITER_ROLES } from '../auth/roles.js';
import { isDraftAuthor, unlinkDraftAction } from '../db/draftLinks.js';
import { parseActAs, resolvePostMandate, resolveTopicMandate } from './writeMandate.js';
import { isGrantActiveForUser } from '../db/proposerGrants.js';
import { isSystemAuthor } from './author.js';
import { toBase64Url } from '../crypto/base64url.js';
import { notifyReply, notifyMentions } from '../notifications/notify.js';
import { extractMentionSlugs, resolveMentions } from './mentions.js';
import { reconcilePostDocs } from '../cip100/reconcile.js';
import { originForNetwork } from '../cip100/origin.js';
import { currentNetwork } from '../api/response.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface HandlerResult {
  status: number;
  json: unknown;
}

type User = { id: string; roles: string[] };

/**
 * Session roles are a login-time cache; DRep write authority additionally
 * requires the synced dreps row to still be active, so a deregistered DRep
 * loses posting rights at the next write after the DRep sync instead of
 * keeping them for the session's remaining lifetime. Only applies when 'drep'
 * is the user's sole writer role: any other writer role is its own live
 * identity and keeps its access. A missing dreps row stays permissive; a
 * freshly registered DRep may not be synced yet, and login itself verified
 * the role on-chain.
 */
async function drepActiveGate(
  db: D1Database,
  user: { id: string; roles: string[] },
): Promise<HandlerResult | null> {
  const writerRoles = user.roles.filter((r) => (WRITER_ROLES as readonly string[]).includes(r));
  if (writerRoles.length !== 1 || writerRoles[0] !== 'drep') return null;
  const row = await db
    .prepare(
      `SELECT d.active AS active FROM users u
         JOIN dreps d ON d.drep_id = u.drep_id
        WHERE u.id = ?1`,
    )
    .bind(user.id)
    .first<{ active: number }>();
  if (row !== null && row.active === 0) {
    return { status: 403, json: { ok: false, error: 'Your DRep registration has ended, so posting is disabled.' } };
  }
  return null;
}

/**
 * The usual write rule for a write no co-proposer mandate covers: an own
 * writer role, and for a sole DRep role a registration that is still active.
 */
async function ownWriterGate(
  db: D1Database,
  user: { id: string; roles: string[] },
): Promise<HandlerResult | null> {
  if (!isWriter(user.roles)) return { status: 403, json: { ok: false, error: 'forbidden' } };
  return drepActiveGate(db, user);
}

const CHOOSE_PROPOSER: HandlerResult = { status: 400, json: { ok: false, error: 'choose_proposer' } };

/**
 * Resolves @slug mentions in a markdown body: returns the link map (href +
 * display label) for the renderer and the linked user ids for the mention
 * notifications. Empty maps when the body contains no mention candidates.
 * Exported for the preview route, so previews render mentions exactly like
 * the stored post.
 */
export async function resolveBodyMentions(
  db: D1Database,
  bodyMd: string,
): Promise<{ mentions: Map<string, MentionLink>; mentionUserIds: string[] }> {
  const slugs = extractMentionSlugs(bodyMd);
  if (slugs.length === 0) return { mentions: new Map(), mentionUserIds: [] };
  const resolved = await resolveMentions(db, slugs);
  return {
    mentions: new Map([...resolved.values()].map((m) => [m.slug, { href: m.href, label: m.label }])),
    mentionUserIds: [...resolved.values()]
      .map((m) => m.userId)
      .filter((id): id is string => id !== null),
  };
}

// ---------------------------------------------------------------------------
// handleCreateTopic
// ---------------------------------------------------------------------------

export interface CreateTopicInput {
  user: User | null;
  body: {
    categorySlug: unknown;
    title: unknown;
    bodyMd: unknown;
    /** Proposal Drafts only: 'self' or { proposerStakeAddr }, see parseActAs. */
    actAs?: unknown;
  };
  db: D1Database;
  rateLimiter: DurableObjectNamespace<RateLimiter>;
  now: number;
}

/**
 * Handles a request to create a new forum topic.
 *
 * Security: requires authenticated user and either a co-proposer mandate (only
 * in Proposal Drafts, resolved in D1 per write) or the usual writer rule,
 * rate-limited per user,
 * validates category access, title length, and body length.
 * The markdown body is rendered and sanitized before storage.
 * Unexpected errors return 500 without leaking internal details.
 */
export async function handleCreateTopic(input: CreateTopicInput): Promise<HandlerResult> {
  try {
    const { user, body, db, rateLimiter, now } = input;

    // 1. Auth check: must be authenticated. Reading is public; posting is
    // reserved for verified DReps/SPOs/CC/proposers (same gate as flagging), or
    // a co-proposer mandate in Proposal Drafts. A mandate is its own authority,
    // so it skips the writer rule. Moderation roles alone do not grant write
    // access.
    if (!user) {
      return { status: 401, json: { ok: false, error: 'unauthorized' } };
    }
    const requestedSlug = typeof body.categorySlug === 'string' ? body.categorySlug : '';
    const mandate = await resolveTopicMandate(db, user.id, requestedSlug, parseActAs(body.actAs));
    if ('error' in mandate) return CHOOSE_PROPOSER;
    if (mandate.grantId === null) {
      const gateResult = await ownWriterGate(db, user);
      if (gateResult) return gateResult;
    }

    // 2. Rate limit: 5 topics per 600s per user.
    const allowed = await checkRate(rateLimiter, `topic:${user.id}`, { max: 5, windowSec: 600, now });
    if (!allowed) {
      return { status: 429, json: { ok: false, error: 'rate_limited' } };
    }

    // 3. Validate categorySlug.
    const categorySlug = requestedSlug;
    const category = getCategory(categorySlug);
    if (!category) {
      return { status: 400, json: { ok: false, error: 'unknown category' } };
    }
    if (!isDiscussion(categorySlug)) {
      return { status: 403, json: { ok: false, error: 'cannot post in this category' } };
    }

    // 4. Validate title.
    const rawTitle = typeof body.title === 'string' ? body.title : '';
    const title = rawTitle.trim();
    if (title.length < 3 || title.length > 200) {
      return { status: 400, json: { ok: false, error: 'title must be 3 to 200 characters' } };
    }

    // 5. Validate bodyMd.
    const bodyMd = (typeof body.bodyMd === 'string' ? body.bodyMd : '').trim();
    const bodyMax = maxPostBody(categorySlug, true);
    if (bodyMd.length === 0 || bodyMd.length > bodyMax) {
      return { status: 400, json: { ok: false, error: `body must be 1 to ${bodyMax} characters` } };
    }

    // 6. Render and sanitize markdown, linkifying resolved @mentions.
    const { mentions, mentionUserIds } = await resolveBodyMentions(db, bodyMd);
    const bodyHtml = renderMarkdown(bodyMd, { mentions });

    // 7. Generate a short CSPRNG-based suffix for the slug (~5 lowercase base64url chars, no underscores).
    const rand = toBase64Url(crypto.getRandomValues(new Uint8Array(4))).replace(/_/g, '').toLowerCase().slice(0, 8);

    // 8. Persist.
    const { topic } = await createTopic(db, {
      categorySlug,
      authorId: user.id,
      title,
      bodyMd,
      bodyHtml,
      source: 'user',
      now,
      rand,
      proposerGrantId: mandate.grantId,
    });

    // 9. Mention notifications for the opening post. Never fail the topic over
    // a notification.
    try {
      await notifyMentions(db, {
        mentionUserIds,
        topicId: topic.id,
        postId: null,
        actorId: user.id,
      });
    } catch {
      // Topic exists; a missed notification is acceptable.
    }

    return { status: 201, json: { ok: true, slug: topic.slug } };
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

// ---------------------------------------------------------------------------
// handleCreatePost
// ---------------------------------------------------------------------------

export interface CreatePostInput {
  user: User | null;
  topicId: string;
  body: {
    bodyMd: unknown;
    /** Optional reply target (one-level threading). */
    parentPostId?: unknown;
    /** Proposal Drafts only: 'self' or { proposerStakeAddr }, see parseActAs. */
    actAs?: unknown;
  };
  db: D1Database;
  rateLimiter: DurableObjectNamespace<RateLimiter>;
  now: number;
}

/**
 * Handles a request to add a reply post to an existing topic.
 *
 * Security: requires authenticated user and either a co-proposer mandate for
 * this topic (the thread of the grant's action, or Proposal Drafts, resolved in
 * D1 per write) or the usual writer rule, rate-limited per user,
 * validates body length. Maps domain errors from createPost to HTTP status codes.
 * Unexpected errors return 500 without leaking internal details.
 */
export async function handleCreatePost(input: CreatePostInput): Promise<HandlerResult> {
  try {
    const { user, topicId, body, db, rateLimiter, now } = input;

    // 1. Auth check: must be authenticated. The mandate is resolved first, so a
    // pure co-proposer can write in its action's thread. A write the mandate
    // covers skips the writer rule and the DRep activity check, the mandate is
    // its own authority. Anything else needs an on-chain writer role (same
    // gate as topic creation and flagging).
    if (!user) {
      return { status: 401, json: { ok: false, error: 'unauthorized' } };
    }
    const topic = await db
      .prepare('SELECT id, category_slug FROM topics WHERE id = ? AND deleted = 0')
      .bind(topicId)
      .first<{ id: string; category_slug: string }>();
    if (!topic) {
      return { status: 404, json: { ok: false, error: 'topic_not_found' } };
    }
    const mandate = await resolvePostMandate(db, user.id, topic, parseActAs(body.actAs));
    if ('error' in mandate) return CHOOSE_PROPOSER;
    if (mandate.grantId === null) {
      const gateResult = await ownWriterGate(db, user);
      if (gateResult) return gateResult;
    }

    // 2. Rate limit: 20 posts per 600s per user.
    const allowed = await checkRate(rateLimiter, `post:${user.id}`, { max: 20, windowSec: 600, now });
    if (!allowed) {
      return { status: 429, json: { ok: false, error: 'rate_limited' } };
    }

    // 3. Validate bodyMd and the optional reply target.
    const bodyMd = (typeof body.bodyMd === 'string' ? body.bodyMd : '').trim();
    if (bodyMd.length === 0 || bodyMd.length > POST_BODY_MAX) {
      return { status: 400, json: { ok: false, error: `body must be 1 to ${POST_BODY_MAX} characters` } };
    }
    const parentPostId = body.parentPostId ?? null;
    if (parentPostId !== null && typeof parentPostId !== 'string') {
      return { status: 400, json: { ok: false, error: 'invalid parent post id' } };
    }

    // 4. Render and sanitize markdown, linkifying resolved @mentions.
    const { mentions, mentionUserIds } = await resolveBodyMentions(db, bodyMd);
    const bodyHtml = renderMarkdown(bodyMd, { mentions });

    // 5. Persist. createPost throws domain errors for locked/missing targets.
    const post = await createPost(db, {
      topicId,
      authorId: user.id,
      bodyMd,
      bodyHtml,
      now,
      parentPostId,
      proposerGrantId: mandate.grantId,
    });

    // 6. Notify: mention rows for the mentioned users, reply rows for the
    // other thread participants (mention recipients excluded so nobody is
    // notified twice for one post). The two writes are independent, so they
    // run concurrently. Never fail the post over a notification.
    try {
      await Promise.all([
        notifyMentions(db, { mentionUserIds, topicId, postId: post.id, actorId: user.id }),
        notifyReply(db, { topicId, postId: post.id, actorId: user.id, excludeUserIds: mentionUserIds }),
      ]);
    } catch {
      // Post exists; a missed notification is acceptable.
    }

    // The id lets the client land on the new post after the reload.
    return { status: 201, json: { ok: true, postId: post.id } };
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'topic_locked') {
        return { status: 403, json: { ok: false, error: 'topic_locked' } };
      }
      if (err.message === 'topic_not_found') {
        return { status: 404, json: { ok: false, error: 'topic_not_found' } };
      }
      if (err.message === 'parent_not_found') {
        return { status: 404, json: { ok: false, error: 'parent_not_found' } };
      }
    }
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

// ---------------------------------------------------------------------------
// handleFlagPost / handleUnflagPost (community flagging)
// ---------------------------------------------------------------------------

export interface FlagPostInput {
  user: User | null;
  postId: string;
  db: D1Database;
  rateLimiter: DurableObjectNamespace<RateLimiter>;
  now: number;
}

/** Shared gate for flag/unflag: returns the user when allowed, else a result to send. */
async function authorizeFlag(
  input: FlagPostInput,
): Promise<{ user: User } | { fail: HandlerResult }> {
  const { user, postId, db, rateLimiter, now } = input;

  // 1. Auth: only on-chain writers can flag. A co-proposer grant never makes
  // a flagger, only own writer roles count.
  if (!user) {
    return { fail: { status: 401, json: { ok: false, error: 'unauthorized' } } };
  }
  const gateResult = await ownWriterGate(db, user);
  if (gateResult) return { fail: gateResult };
  if (!canJudgePosts(user)) {
    return { fail: { status: 403, json: { ok: false, error: 'forbidden' } } };
  }

  // 2 + 3. Rate limit (30 toggles per 600s per user) and post lookup are
  // independent round-trips (DO vs D1), so they run concurrently. The rate
  // verdict is checked first to keep the error precedence.
  const [allowed, post] = await Promise.all([
    checkRate(rateLimiter, `flag:${user.id}`, { max: 30, windowSec: 600, now }),
    getPostById(db, postId),
  ]);
  if (!allowed) {
    return { fail: { status: 429, json: { ok: false, error: 'rate_limited' } } };
  }
  if (!post || post.deleted) {
    return { fail: { status: 404, json: { ok: false, error: 'post_not_found' } } };
  }

  // 4. You cannot flag your own post or a system/governance post.
  if (post.author_id === user.id) {
    return { fail: { status: 403, json: { ok: false, error: 'cannot_flag_own' } } };
  }
  if (isSystemAuthor(post.author_id)) {
    return { fail: { status: 403, json: { ok: false, error: 'cannot_flag_system' } } };
  }

  return { user };
}

function flagResult(state: FlagState, flagged: boolean): HandlerResult {
  return { status: 200, json: { ok: true, flagged, flagCount: state.flagCount, hidden: state.hidden } };
}

/**
 * Shared flag/unflag flow. `flag` true records a community flag (after 3 distinct
 * writers flag a post it is hidden); `flag` false withdraws the caller's flag,
 * un-hiding the post if the count drops below the threshold. Flagging is
 * idempotent per writer. Unexpected errors return 500 without leaking detail.
 */
async function handleFlagToggle(input: FlagPostInput, flag: boolean): Promise<HandlerResult> {
  try {
    const gate = await authorizeFlag(input);
    if ('fail' in gate) return gate.fail;

    const state = flag
      ? await flagPost(input.db, { postId: input.postId, flaggerId: gate.user.id, now: input.now })
      : await unflagPost(input.db, { postId: input.postId, flaggerId: gate.user.id });
    return flagResult(state, flag);
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

export const handleFlagPost = (input: FlagPostInput): Promise<HandlerResult> =>
  handleFlagToggle(input, true);

export const handleUnflagPost = (input: FlagPostInput): Promise<HandlerResult> =>
  handleFlagToggle(input, false);

// ---------------------------------------------------------------------------
// handleReactToPost / handleClearReaction (thumbs up / thumbs down)
// ---------------------------------------------------------------------------

export interface ReactPostInput {
  user: User | null;
  postId: string;
  db: D1Database;
  rateLimiter: DurableObjectNamespace<RateLimiter>;
  now: number;
}

/**
 * Shared react/withdraw flow. A writer holds at most one reaction per post;
 * setting the other side replaces it. Reacting to your own post is refused, and
 * so is reacting to a system (governance) post: the opening post there is a
 * neutral mirror of an on-chain action, and a stake-free thumb next to the real
 * tally only reads as a rival vote. Unexpected errors return 500 without
 * leaking detail.
 */
async function handleReactionChange(
  input: ReactPostInput,
  reaction: Reaction | null,
): Promise<HandlerResult> {
  try {
    const { user, postId, db, rateLimiter, now } = input;

    // 1. Auth: only on-chain writers can react (same gate as flagging). A
    // co-proposer grant never makes a reactor, only own writer roles count.
    if (!user) {
      return { status: 401, json: { ok: false, error: 'unauthorized' } };
    }
    const gateResult = await ownWriterGate(db, user);
    if (gateResult) return gateResult;
    if (!canJudgePosts(user)) {
      return { status: 403, json: { ok: false, error: 'forbidden' } };
    }

    // 2 + 3. Rate limit (60 toggles per 600s; reactions are lightweight) and
    // post lookup are independent round-trips (DO vs D1), so they run
    // concurrently. The rate verdict is checked first to keep error precedence.
    const [allowed, post] = await Promise.all([
      checkRate(rateLimiter, `react:${user.id}`, { max: 60, windowSec: 600, now }),
      getPostById(db, postId),
    ]);
    if (!allowed) {
      return { status: 429, json: { ok: false, error: 'rate_limited' } };
    }
    if (!post || post.deleted) {
      return { status: 404, json: { ok: false, error: 'post_not_found' } };
    }

    // 4. You cannot react to your own post, nor to a system/governance post.
    if (post.author_id === user.id) {
      return { status: 403, json: { ok: false, error: 'cannot_react_own' } };
    }
    if (isSystemAuthor(post.author_id)) {
      return { status: 403, json: { ok: false, error: 'cannot_react_system' } };
    }

    const state: ReactionState = reaction
      ? await setReaction(db, { postId, reactorId: user.id, reaction, now })
      : await clearReaction(db, { postId, reactorId: user.id });

    return {
      status: 200,
      json: { ok: true, reaction, upCount: state.upCount, downCount: state.downCount },
    };
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

/** Sets the caller's reaction; 400 unless reaction is 'up' or 'down'. */
export async function handleReactToPost(
  input: ReactPostInput,
  reaction: unknown,
): Promise<HandlerResult> {
  if (!isReaction(reaction)) {
    return { status: 400, json: { ok: false, error: 'reaction must be "up" or "down"' } };
  }
  return handleReactionChange(input, reaction);
}

/** Withdraws the caller's reaction (no-op if none). */
export const handleClearReaction = (input: ReactPostInput): Promise<HandlerResult> =>
  handleReactionChange(input, null);

// ---------------------------------------------------------------------------
// handleEditPost / handleEditTitle (owner edits; grace window + revisions)
// ---------------------------------------------------------------------------

/** Reconciles a post's CIP-100 documents without ever failing the caller. A
 *  swallowed failure is not a lost document: the gov-sync cron finds the post
 *  stale (posts.edited_at ahead of the head's source_edited_at) and reconciles
 *  it on the next run. */
async function emitCip100(db: D1Database, postId: string, now: number): Promise<void> {
  try {
    const network = currentNetwork().network === 'preprod' ? 'preprod' : 'mainnet';
    await reconcilePostDocs(db, postId, { origin: originForNetwork(network), network, now });
  } catch (err) {
    // Never fails the write: the cron repairs it. Logged with the post id all
    // the same, or a permanently reproducible emit failure stays invisible
    // behind a repair loop that quietly retries it forever.
    console.error(`[cip100] emit failed for post ${postId}:`, err);
  }
}

/** Maps editPost/editTitle domain errors to HTTP results. */
function editError(err: unknown): HandlerResult {
  const msg = err instanceof Error ? err.message : '';
  if (msg === 'post_not_found' || msg === 'topic_not_found') {
    return { status: 404, json: { ok: false, error: msg } };
  }
  if (msg === 'not_owner' || msg === 'post_hidden' || msg === 'topic_locked' || msg === 'not_user_topic' || msg === 'frozen_rationale') {
    return { status: 403, json: { ok: false, error: msg } };
  }
  if (msg === 'mandate_mismatch') {
    return { status: 403, json: { ok: false, error: 'forbidden' } };
  }
  return { status: 500, json: { ok: false, error: 'internal error' } };
}

export interface EditPostInput {
  user: User | null;
  postId: string;
  body: { bodyMd: unknown };
  db: D1Database;
  rateLimiter: DurableObjectNamespace<RateLimiter>;
  now: number;
}

/**
 * Edits the caller's own post body. A post stamped with a grant skips the
 * writer rule and relies on editPost's check that exactly that grant is still
 * active for the author. An unstamped post takes the same writer gate as
 * posting. Rate-limited;
 * validates length; re-renders+sanitizes markdown. Ownership, hidden, and topic
 * lock/delete checks live in editPost (domain errors mapped via editError).
 *
 * Reconciles the post's CIP-100 documents twice, before and after the write:
 * once to freeze the text that was publicly visible until now, once to publish
 * the edited text as the next version. Both are best effort and never fail the
 * edit, see emitCip100.
 */
export async function handleEditPost(input: EditPostInput): Promise<HandlerResult> {
  try {
    const { user, postId, body, db, rateLimiter, now } = input;
    if (!user) return { status: 401, json: { ok: false, error: 'unauthorized' } };
    const stamp = await db
      .prepare('SELECT proposer_grant_id FROM posts WHERE id = ?')
      .bind(postId)
      .first<{ proposer_grant_id: string | null }>();
    const grantId = stamp?.proposer_grant_id ?? null;
    const ownWriter = grantId === null;
    if (ownWriter) {
      const gateResult = await ownWriterGate(db, user);
      if (gateResult) return gateResult;
    } else if (!(await isGrantActiveForUser(db, grantId, user.id))) {
      // Checked here as well as in editPost, so a caller without the grant
      // never reaches the CIP-100 freeze below.
      return { status: 403, json: { ok: false, error: 'forbidden' } };
    }

    const allowed = await checkRate(rateLimiter, `edit:${user.id}`, { max: 30, windowSec: 600, now });
    if (!allowed) return { status: 429, json: { ok: false, error: 'rate_limited' } };

    const bodyMd = (typeof body.bodyMd === 'string' ? body.bodyMd : '').trim();
    // Only a body past the normal cap pays for the placement lookup: a Proposal
    // Drafts opening post may run longer than any other post.
    let bodyMax = POST_BODY_MAX;
    if (bodyMd.length > POST_BODY_MAX) {
      const placement = await getPostPlacement(db, postId);
      if (placement) bodyMax = maxPostBody(placement.categorySlug, placement.isOpeningPost);
    }
    if (bodyMd.length === 0 || bodyMd.length > bodyMax) {
      return { status: 400, json: { ok: false, error: `body must be 1 to ${bodyMax} characters` } };
    }
    // Render with mention links, but edits never create notifications: a
    // mention added after the fact stays silent by design (Phase 1).
    const { mentions } = await resolveBodyMentions(db, bodyMd);
    const bodyHtml = renderMarkdown(bodyMd, { mentions });

    // Freeze what is about to be overwritten. A post whose grace window has
    // closed but which the cron has not reached yet has no document, and
    // editPost replaces body_md in place, so the text that was publicly visible
    // until now would otherwise never become a version. In every other case this
    // is a no-op: inside the grace window the post is out of scope, and with a
    // current head the reconciler returns 'unchanged'.
    await emitCip100(db, postId, now);

    try {
      const { edited } = await editPost(db, {
        postId,
        authorId: user.id,
        bodyMd,
        bodyHtml,
        now,
        ownWriter,
      });
      // Publish the edited text as the next version. Its own try/catch, not the
      // notification one, so a notification failure cannot skip the emit.
      await emitCip100(db, postId, now);
      return { status: 200, json: { ok: true, edited } };
    } catch (err) {
      return editError(err);
    }
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

export interface EditTitleInput {
  user: User | null;
  topicId: string;
  body: { title: unknown };
  db: D1Database;
  rateLimiter: DurableObjectNamespace<RateLimiter>;
  now: number;
}

/**
 * Edits the caller's own topic title (opening-post author). Same split as
 * handleEditPost: a topic stamped with a grant follows that grant, an
 * unstamped one the writer gate. Rate-limited; validates 3..200 chars. Slug stays frozen. Ownership / governance
 * / lock checks live in editTitle.
 */
export async function handleEditTitle(input: EditTitleInput): Promise<HandlerResult> {
  try {
    const { user, topicId, body, db, rateLimiter, now } = input;
    if (!user) return { status: 401, json: { ok: false, error: 'unauthorized' } };
    const stamp = await db
      .prepare('SELECT proposer_grant_id FROM topics WHERE id = ?')
      .bind(topicId)
      .first<{ proposer_grant_id: string | null }>();
    const ownWriter = !stamp?.proposer_grant_id;
    if (ownWriter) {
      const gateResult = await ownWriterGate(db, user);
      if (gateResult) return gateResult;
    }

    const allowed = await checkRate(rateLimiter, `edit:${user.id}`, { max: 30, windowSec: 600, now });
    if (!allowed) return { status: 429, json: { ok: false, error: 'rate_limited' } };

    const title = (typeof body.title === 'string' ? body.title : '').trim();
    if (title.length < 3 || title.length > 200) {
      return { status: 400, json: { ok: false, error: 'title must be 3 to 200 characters' } };
    }

    try {
      await editTitle(db, { topicId, authorId: user.id, title, now, ownWriter });
      return { status: 200, json: { ok: true } };
    } catch (err) {
      return editError(err);
    }
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

export interface DraftUnlinkInput {
  user: User | null;
  topicId: string;
  body: { actionId: unknown };
  db: D1Database;
  rateLimiter: DurableObjectNamespace<RateLimiter>;
  now: number;
}

/**
 * Detaches a governance action from a Proposal Drafts thread whose references
 * named it without being the draft's own action. Open to the draft's author
 * under the same mandate the title editor checks, or to a moderator. No writer
 * role is required: an author whose role lapsed must still be able to undo a
 * stranger's link.
 */
export async function handleDraftUnlink(input: DraftUnlinkInput): Promise<HandlerResult> {
  try {
    const { user, topicId, body, db, rateLimiter, now } = input;
    if (!user) return { status: 401, json: { ok: false, error: 'unauthorized' } };

    const raw = (body as { actionId?: unknown } | null)?.actionId;
    const actionId = typeof raw === 'string' ? raw.trim() : '';
    if (!actionId) return { status: 400, json: { ok: false, error: 'missing action id' } };

    const topic = await db
      .prepare('SELECT author_id, category_slug, deleted, proposer_grant_id FROM topics WHERE id = ?')
      .bind(topicId)
      .first<{ author_id: string; category_slug: string; deleted: number; proposer_grant_id: string | null }>();
    if (!topic || topic.deleted || topic.category_slug !== PROPOSAL_DRAFTS_CATEGORY_SLUG) {
      return { status: 404, json: { ok: false, error: 'not found' } };
    }

    // No writer role or DRep activity check (an author whose role lapsed must
    // still undo a stranger's link). isDraftAuthor re-checks a stamped draft's
    // grant in D1, so a revoked co-proposer cannot act.
    if (!isModerator(user.roles) && !(await isDraftAuthor(db, topic, user))) {
      return { status: 403, json: { ok: false, error: 'forbidden' } };
    }

    const allowed = await checkRate(rateLimiter, `edit:${user.id}`, { max: 30, windowSec: 600, now });
    if (!allowed) return { status: 429, json: { ok: false, error: 'rate_limited' } };

    const linked = await db
      .prepare('SELECT 1 AS x FROM governance_actions WHERE id = ? AND draft_topic_id = ?')
      .bind(actionId, topicId)
      .first<{ x: number }>();
    if (!linked) return { status: 404, json: { ok: false, error: 'not linked' } };
    await unlinkDraftAction(db, actionId, topicId);
    return { status: 200, json: { ok: true } };
  } catch {
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}
