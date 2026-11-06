// Orders one top-level post's replies as a tree for the thread view.
//
// Storage stays flat: every reply's parent_post_id is the top-level post, so
// one query loads a whole branch. The tree comes from reply_to_post_id, the
// post a reply actually answered (the top-level post itself for a direct
// reply, null for replies written before that column existed).

export interface ReplyNode<P> {
  post: P;
  /** 1 for a direct reply to the top-level post, 2 for a reply to that, and so on. */
  depth: number;
  /** The reply this one answered, null when it sits directly under the top-level post. */
  replyTo: P | null;
}

/**
 * Depth-first order (each reply followed by its own replies), siblings keep
 * their input order, which is oldest first. A reply whose target is missing
 * (the top-level post, a deleted reply, or null) sits at depth 1.
 */
export function buildReplyTree<P extends { id: string; reply_to_post_id: string | null }>(
  replies: P[],
): ReplyNode<P>[] {
  const byId = new Map(replies.map((p) => [p.id, p]));
  const childrenOf = new Map<string | null, P[]>();
  for (const post of replies) {
    const target = post.reply_to_post_id && byId.has(post.reply_to_post_id) ? post.reply_to_post_id : null;
    const list = childrenOf.get(target);
    if (list) list.push(post);
    else childrenOf.set(target, [post]);
  }

  const out: ReplyNode<P>[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const post of childrenOf.get(parentId) ?? []) {
      out.push({ post, depth, replyTo: parentId ? (byId.get(parentId) ?? null) : null });
      walk(post.id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}
