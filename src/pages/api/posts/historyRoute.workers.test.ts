/// <reference types="@cloudflare/workers-types" />
// Exercises the GET history handler logic via getPostHistory + the gate. The
// route file is a thin wrapper; here we assert the gate decision and payload.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic, getPostHistory } from '@/lib/db/forum';
import { isModerator } from '@/lib/auth/roles';

const db = () => env.DB;
const NOW = 1_752_000_000_000;

let seq = 0;
async function newPost(authorId: string): Promise<string> {
  seq++;
  const { firstPost } = await createTopic(db(), {
    categorySlug: 'general', authorId, title: `Hist route ${seq}`,
    bodyMd: 'b', bodyHtml: '<p>b</p>', now: NOW, rand: `hr${seq}`,
  });
  return firstPost.id;
}

// Mirror of the route's gate, kept tiny so the rule is unit-tested.
function canSee(history: { hidden: boolean; authorId: string }, user: { id: string; roles: string[] } | null) {
  if (!history.hidden) return true;
  return !!user && (user.id === history.authorId || isModerator(user.roles));
}

describe('post history visibility gate', () => {
  it('a visible post is public', async () => {
    const postId = await newPost('drep-a');
    const h = await getPostHistory(db(), postId);
    expect(h).not.toBeNull();
    expect(canSee(h!, null)).toBe(true);
  });

  it('a hidden post is not visible to anonymous or other writers', async () => {
    const postId = await newPost('drep-a');
    await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(postId).run();
    const h = await getPostHistory(db(), postId);
    expect(canSee(h!, null)).toBe(false);
    expect(canSee(h!, { id: 'drep-b', roles: ['drep'] })).toBe(false);
  });

  it('a hidden post is visible to its author', async () => {
    const postId = await newPost('drep-a');
    await db().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').bind(postId).run();
    const h = await getPostHistory(db(), postId);
    expect(canSee(h!, { id: 'drep-a', roles: ['drep'] })).toBe(true);
  });
});
