/// <reference types="@cloudflare/workers-types" />
// Viewer post-state tests -- run in real workerd via @cloudflare/vitest-pool-workers.
// Focus: the batched flag + reaction lookup stays correct AND under D1's
// 100-bind cap when a thread page passes more than 100 post ids (top-level
// posts are capped at 100 per page, but replies are unbounded).
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from '../db/forum.js';
import { flagPost } from '../db/postFlags.js';
import { setReaction } from '../db/postReactions.js';
import { bindCountingDb } from '../db/__tests__/bindCountingDb.js';
import { loadViewerPostState, emptyViewerPostState } from './viewerPostState.js';

const db = () => env.DB;
const NOW = 1_754_000_000_000;

let seq = 0;
async function newPostId(): Promise<string> {
  seq++;
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general',
    authorId: 'author-vps',
    title: `Viewer state fixture ${seq}`,
    bodyMd: 'body',
    bodyHtml: '<p>body</p>',
    now: NOW,
    rand: `vps${seq}`,
  });
  return firstPost.id;
}

describe('loadViewerPostState', () => {
  it('returns empty state for an empty post list', async () => {
    const state = await loadViewerPostState(db(), 'viewer-1', []);
    expect(state).toEqual(emptyViewerPostState());
  });

  it('returns flags and reactions for the viewer in one batch', async () => {
    const viewer = 'viewer-batch';
    const a = await newPostId();
    const b = await newPostId();
    const c = await newPostId();
    await setReaction(db(), { postId: a, reactorId: viewer, reaction: 'up', now: NOW });
    await setReaction(db(), { postId: c, reactorId: viewer, reaction: 'down', now: NOW });
    // Another viewer's reaction never leaks into this viewer's state.
    await setReaction(db(), { postId: b, reactorId: 'viewer-other', reaction: 'up', now: NOW });
    await flagPost(db(), { postId: b, flaggerId: viewer, now: NOW });

    const state = await loadViewerPostState(db(), viewer, [a, b, c]);
    expect(state.reactions.get(a)).toBe('up');
    expect(state.reactions.get(c)).toBe('down');
    expect(state.reactions.has(b)).toBe(false);
    expect(state.flaggedPostIds.has(b)).toBe(true);
    expect(state.flaggedPostIds.has(a)).toBe(false);
  });

  it('stays under the D1 100-bind cap and merges results across chunks', async () => {
    // The real posts sit at the END of a 150-id list, so their rows come from
    // the second chunk. viewerId occupies one bind per statement; a single
    // statement would bind 151 parameters, over production D1's cap.
    const viewer = 'viewer-bindcap';
    const flaggedId = await newPostId();
    const reactedId = await newPostId();
    await flagPost(db(), { postId: flaggedId, flaggerId: viewer, now: NOW });
    await setReaction(db(), { postId: reactedId, reactorId: viewer, reaction: 'up', now: NOW });

    const ids = [
      ...Array.from({ length: 148 }, (_, i) => `missing-post-${i}`),
      flaggedId,
      reactedId,
    ];

    const counted = bindCountingDb(db());
    const state = await loadViewerPostState(counted.db, viewer, ids);

    expect(state.flaggedPostIds).toEqual(new Set([flaggedId]));
    expect(state.reactions.get(reactedId)).toBe('up');
    expect(state.reactions.size).toBe(1);
    expect(counted.maxBinds()).toBeLessThanOrEqual(100);
  });
});
