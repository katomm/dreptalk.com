// Viewer-facing policy for a single post: who may flag it, and who may still
// read it once the community has hidden it. Kept out of the page template so the
// same rules can back a future moderation view without drifting.

import { isWriter, isModerator, canJudgePosts } from '../auth/roles.js';

/**
 * The three states the reaction row can be in. One value rather than a pair of
 * booleans, so no caller can hold the incoherent "may toggle, but hidden".
 */
export type ReactionAffordance = 'interactive' | 'readonly' | 'hidden';

/** The session user shape components receive (mirrors App.Locals.user). */
export interface SessionUser {
  id: string;
  roles: string[];
}

export interface PostViewerContext {
  /** The viewer authored this post. */
  isOwnPost: boolean;
  /** The viewer may read the body (not hidden, or viewer is the author/moderator). */
  canSeeContent: boolean;
  /** The viewer may flag this post (a writer, not the author, not a system post). */
  canFlag: boolean;
  /**
   * How the reaction affordance renders: 'interactive' for a viewer who may
   * toggle, 'readonly' for live counts they cannot change, 'hidden' where the
   * post carries no reactions at all.
   */
  reactions: ReactionAffordance;
  /**
   * The viewer may edit this post: their own, not system, not hidden, and
   * either stamped with a grant that is still active for them, or unstamped
   * and the viewer holds an own writer role.
   */
  canEdit: boolean;
}

/**
 * The edit rule shared by posts and titles, mirroring editPost/editTitle. A
 * row stamped with a grant follows exactly that grant (stampedGrantActive, read
 * from D1 by the page), own writer roles do not override it. An unstamped row
 * needs an own writer role.
 */
function mayEditOwnRow(
  proposerGrantId: string | null | undefined,
  roles: readonly string[],
  stampedGrantActive: boolean,
): boolean {
  return proposerGrantId ? stampedGrantActive : isWriter(roles);
}

/** The opening-post author may edit the title of their own non-locked user topic. */
export function canEditTitle(
  topic: { author_id: string; source: string; locked: boolean; proposer_grant_id: string | null },
  user: { id: string; roles: readonly string[] } | null,
  stampedGrantActive: boolean,
): boolean {
  if (!user || topic.source !== 'user' || topic.author_id !== user.id || topic.locked) return false;
  return mayEditOwnRow(topic.proposer_grant_id, user.roles, stampedGrantActive);
}

/**
 * Computes the flag/visibility context for one post and viewer.
 * - canSeeContent: a hidden post stays readable for its author and moderators.
 * - canFlag: only on-chain writers can flag (a co-proposer alone does not
 *   count, see canJudgePosts), never their own post or a system/governance post
 *   (authorIsSystem).
 * - reactions: only those same writers may toggle, never on their own post. On a
 *   system/governance post the row is hidden outright: a thumbs up on the
 *   neutral mirror of an on-chain action reads as a stake-free straw poll next
 *   to the real tally.
 * - canEdit: see mayEditOwnRow. stampedGrantActive says whether the post's
 *   stored grant is active for this viewer, false when the post is unstamped.
 */
export function postViewerContext(
  post: { author_id: string; hidden: boolean; proposer_grant_id?: string | null },
  user: { id: string; roles: readonly string[] } | null,
  authorIsSystem: boolean,
  stampedGrantActive = false,
): PostViewerContext {
  const isOwnPost = !!user && post.author_id === user.id;
  const roles = user?.roles ?? [];
  const canSeeContent = !post.hidden || isOwnPost || isModerator(roles);
  const judges = !!user && canJudgePosts(user);
  const canFlag = judges && !isOwnPost && !authorIsSystem;
  const reactions: ReactionAffordance = authorIsSystem
    ? 'hidden'
    : judges && !isOwnPost
      ? 'interactive'
      : 'readonly';
  const canEdit =
    isOwnPost && !authorIsSystem && !post.hidden && mayEditOwnRow(post.proposer_grant_id, roles, stampedGrantActive);
  return { isOwnPost, canSeeContent, canFlag, reactions, canEdit };
}
