// Viewer-facing policy for a single post: who may flag it, and who may still
// read it once the community has hidden it. Kept out of the page template so the
// same rules can back a future moderation view without drifting.

import { isWriter, isModerator } from '../auth/roles.js';

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
  /** The viewer may react to this post (a writer, not the author; system posts allowed). */
  canReact: boolean;
}

/**
 * Computes the flag/visibility context for one post and viewer.
 * - canSeeContent: a hidden post stays readable for its author and moderators.
 * - canFlag: only on-chain writers can flag, never their own post or a
 *   system/governance post (authorIsSystem).
 * - canReact: only on-chain writers, never their own post. Unlike flagging,
 *   system posts are reactable: the opening post of a governance action is
 *   exactly where readers signal support or opposition.
 */
export function postViewerContext(
  post: { author_id: string; hidden: boolean },
  user: { id: string; roles: readonly string[] } | null,
  authorIsSystem: boolean,
): PostViewerContext {
  const isOwnPost = !!user && post.author_id === user.id;
  const roles = user?.roles ?? [];
  const canSeeContent = !post.hidden || isOwnPost || isModerator(roles);
  const canFlag = isWriter(roles) && !isOwnPost && !authorIsSystem;
  const canReact = isWriter(roles) && !isOwnPost;
  return { isOwnPost, canSeeContent, canFlag, canReact };
}
