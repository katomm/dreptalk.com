/// <reference types="@cloudflare/workers-types" />
// The viewer's own relationship to the posts on a thread page: which posts
// they flagged and how they reacted. Both lookups share the same gate (an
// authenticated writer) and the same bind inputs, so they run as one D1 batch
// (a single round-trip) instead of two queries.

import { flaggedPostIdsStmt } from '../db/postFlags.js';
import { viewerReactionsStmt, type Reaction } from '../db/postReactions.js';

export interface ViewerPostState {
  /** Posts on this page the viewer has flagged. */
  flaggedPostIds: Set<string>;
  /** The viewer's reaction per post id. */
  reactions: Map<string, Reaction>;
}

/** The state of a viewer who cannot flag or react (anonymous or non-writer). */
export function emptyViewerPostState(): ViewerPostState {
  return { flaggedPostIds: new Set(), reactions: new Map() };
}

/** Loads both per-viewer lookups for the given posts in one batched round-trip. */
export async function loadViewerPostState(
  db: D1Database,
  viewerId: string,
  postIds: string[],
): Promise<ViewerPostState> {
  if (postIds.length === 0) return emptyViewerPostState();

  const [flags, reactions] = await db.batch([
    flaggedPostIdsStmt(db, viewerId, postIds),
    viewerReactionsStmt(db, viewerId, postIds),
  ]);

  const flagRows = (flags.results ?? []) as { post_id: string }[];
  const reactionRows = (reactions.results ?? []) as { post_id: string; reaction: Reaction }[];

  return {
    flaggedPostIds: new Set(flagRows.map((r) => r.post_id)),
    reactions: new Map(reactionRows.map((r) => [r.post_id, r.reaction])),
  };
}
