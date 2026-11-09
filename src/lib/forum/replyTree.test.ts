import { describe, it, expect } from 'vitest';
import { buildReplyTree } from './replyTree.js';

const r = (id: string, replyTo: string | null = null) => ({ id, reply_to_post_id: replyTo });
const shape = (nodes: ReturnType<typeof buildReplyTree<ReturnType<typeof r>>>) =>
  nodes.map((n) => `${n.post.id}@${n.depth}<${n.replyTo?.id ?? '-'}`);

describe('buildReplyTree', () => {
  it('keeps flat direct replies at depth 1 in order', () => {
    expect(shape(buildReplyTree([r('a'), r('b')]))).toEqual(['a@1<-', 'b@1<-']);
  });

  it('nests each reply under the one it answered, depth first', () => {
    const tree = buildReplyTree([r('a'), r('b'), r('a1', 'a'), r('a1x', 'a1'), r('b1', 'b'), r('a2', 'a')]);
    expect(shape(tree)).toEqual(['a@1<-', 'a1@2<a', 'a1x@3<a1', 'a2@2<a', 'b@1<-', 'b1@2<b']);
  });

  it('has no depth limit', () => {
    const chain = [r('d1'), r('d2', 'd1'), r('d3', 'd2'), r('d4', 'd3'), r('d5', 'd4'), r('d6', 'd5'), r('d7', 'd6'), r('d8', 'd7')];
    expect(buildReplyTree(chain).map((n) => n.depth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('moves a reply to a missing target up to depth 1', () => {
    expect(shape(buildReplyTree([r('a'), r('orphan', 'gone')]))).toEqual(['a@1<-', 'orphan@1<-']);
  });

  it('returns nothing for no replies', () => {
    expect(buildReplyTree([])).toEqual([]);
  });
});
