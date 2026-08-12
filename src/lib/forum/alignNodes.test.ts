import { describe, it, expect } from 'vitest';
import { alignNodes } from './alignNodes.js';
import type { HtmlNode } from './htmlNodes.js';
import { parseSanitizedHtml } from './htmlNodes.js';

const p = (html: string) => parseSanitizedHtml(html);

describe('alignNodes', () => {
  it('pairs identical lists one to one', () => {
    expect(alignNodes(p('<p>a</p><p>b</p>'), p('<p>a</p><p>b</p>'))).toEqual([
      { old: 0, new: 0 },
      { old: 1, new: 1 },
    ]);
  });

  it('reports an inserted node as new-only', () => {
    expect(alignNodes(p('<p>a</p>'), p('<p>a</p><p>b</p>'))).toEqual([
      { old: 0, new: 0 },
      { old: null, new: 1 },
    ]);
  });

  it('reports a deleted node as old-only', () => {
    expect(alignNodes(p('<p>a</p><p>b</p>'), p('<p>a</p>'))).toEqual([
      { old: 0, new: 0 },
      { old: 1, new: null },
    ]);
  });

  it('pairs a reworded node inside a gap by similarity', () => {
    // Alpha anchors exactly, New is an insertion, Beta pairs with Beta changed.
    const slots = alignNodes(
      p('<li>Alpha</li><li>Beta</li>'),
      p('<li>Alpha</li><li>New</li><li>Beta changed</li>'),
    );
    expect(slots).toEqual([
      { old: 0, new: 0 },
      { old: null, new: 1 },
      { old: 1, new: 2 },
    ]);
  });

  it('shows a moved node as a delete plus an add, not as unchanged', () => {
    // Similarity must not reach across an anchor, or the move vanishes. The LCS
    // anchors old B (index 1) against new B (index 0); A survives on both sides but
    // falls on either side of that anchor, so it comes out old-only then new-only
    // rather than paired with itself. A count-only assertion cannot tell this apart
    // from the other anchor choice that also satisfies "1 pair, 1 old-only, 1
    // new-only", so this pins the exact slot list.
    const slots = alignNodes(p('<p>A</p><p>B</p>'), p('<p>B</p><p>A</p>'));
    expect(slots).toEqual([
      { old: 0, new: null },
      { old: 1, new: 0 },
      { old: null, new: 1 },
    ]);
  });

  it('keeps the leftmost candidate on a similarity tie', () => {
    // Both new items share exactly one of the old item's two words, so they score
    // identically. The tie-break must keep the earlier candidate, or the choice is
    // just whichever list happens to be scanned last.
    const slots = alignNodes(
      p('<li>alpha beta</li>'),
      p('<li>alpha gamma</li><li>alpha delta</li>'),
    );
    expect(slots).toEqual([
      { old: 0, new: 0 },
      { old: null, new: 1 },
    ]);
  });

  it('never pairs different tags', () => {
    const slots = alignNodes(p('<h2>x</h2>'), p('<p>x</p>'));
    expect(slots.every((s) => s.old === null || s.new === null)).toBe(true);
  });

  it('leaves a dissimilar pair unmatched', () => {
    const slots = alignNodes(p('<p>completely different words</p>'), p('<p>nothing alike</p>'));
    expect(slots.every((s) => s.old === null || s.new === null)).toBe(true);
  });

  it('emits every index of both lists exactly once', () => {
    const oldNodes = p('<p>a</p><p>b</p><p>c</p>');
    const newNodes = p('<p>a</p><p>c changed</p><p>d</p>');
    const slots = alignNodes(oldNodes, newNodes);
    const numeric = (a: number, b: number) => a - b;
    // .filter((s) => s.old !== null) narrows the predicate, not the mapped array: TS
    // does not carry that through a later .map. Filtering after mapping, with a type
    // guard, narrows the array itself to number[] so numeric's plain signature holds.
    const isNumber = (n: number | null): n is number => n !== null;
    expect(
      slots
        .map((s) => s.old)
        .filter(isNumber)
        .sort(numeric),
    ).toEqual([0, 1, 2]);
    expect(
      slots
        .map((s) => s.new)
        .filter(isNumber)
        .sort(numeric),
    ).toEqual([0, 1, 2]);
  });

  it('never pairs void nodes of different tags', () => {
    // Two mismatched void tags never share a strict key, so they always land in a
    // gap. sameShape falls through both its branches for a void kind, so they are
    // never treated as candidates there either, and come out as a delete plus an add.
    const slots = alignNodes(p('<hr>'), p('<br>'));
    expect(slots).toEqual([
      { old: 0, new: null },
      { old: null, new: 0 },
    ]);
  });

  it('returns an empty slot list for two empty inputs', () => {
    expect(alignNodes([], [])).toEqual([]);
  });

  it('reports every node as new-only when the old list is empty', () => {
    expect(alignNodes([], p('<p>a</p>'))).toEqual([{ old: null, new: 0 }]);
  });

  it('reports every node as old-only when the new list is empty', () => {
    expect(alignNodes(p('<p>a</p>'), [])).toEqual([{ old: 0, new: null }]);
  });
});

describe('alignNodes and ignorable whitespace', () => {
  // renderMarkdown puts a newline between list items, so these child lists are
  // [ws, li, ws, li, ws] and [ws, li, ws, li, ws, li, ws]. If those whitespace
  // nodes reach the matcher they all look alike and it anchors on them.
  const children = (html: string) => {
    const [node] = parseSanitizedHtml(html);
    if (node.kind !== 'element') throw new Error('expected an element');
    return node.children;
  };

  const oldChildren = children('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  const newChildren = children('<ul>\n<li>a</li>\n<li>x</li>\n<li>b</li>\n</ul>');
  const slots = alignNodes(oldChildren, newChildren);

  const isIgnorable = (nodes: typeof oldChildren, i: number): boolean => {
    const n = nodes[i];
    return n.kind === 'text' && n.ignorable;
  };

  it('pairs the two surviving items and reports the third as an insertion', () => {
    const pairedItems = slots.filter(
      (s) => s.old !== null && s.new !== null && !isIgnorable(newChildren, s.new),
    );
    const insertedItems = slots.filter(
      (s) => s.old === null && s.new !== null && !isIgnorable(newChildren, s.new),
    );
    expect(pairedItems).toHaveLength(2);
    expect(insertedItems).toHaveLength(1);
  });

  it('passes new-tree whitespace through and drops old-tree whitespace', () => {
    const ignorableNew = newChildren.map((_, i) => i).filter((i) => isIgnorable(newChildren, i));
    for (const i of ignorableNew) {
      expect(slots).toContainEqual({ old: null, new: i });
    }
    const oldIndices = slots.filter((s) => s.old !== null).map((s) => s.old as number);
    for (const i of oldChildren.map((_, i) => i).filter((i) => isIgnorable(oldChildren, i))) {
      expect(oldIndices).not.toContain(i);
    }
  });

  it('keeps indices strictly increasing with whitespace in the mix', () => {
    let lastOld = -1;
    let lastNew = -1;
    for (const s of slots) {
      if (s.old !== null) {
        expect(s.old).toBeGreaterThan(lastOld);
        lastOld = s.old;
      }
      if (s.new !== null) {
        expect(s.new).toBeGreaterThan(lastNew);
        lastNew = s.new;
      }
    }
  });

  it('produces strictly increasing indices on both sides', () => {
    const slots = alignNodes(
      p('<p>one</p><p>two</p><p>three</p>'),
      p('<p>one</p><p>two and a half</p><p>three</p>'),
    );
    let lastOld = -1;
    let lastNew = -1;
    for (const s of slots) {
      if (s.old !== null) {
        expect(s.old).toBeGreaterThan(lastOld);
        lastOld = s.old;
      }
      if (s.new !== null) {
        expect(s.new).toBeGreaterThan(lastNew);
        lastNew = s.new;
      }
    }
  });

  // The cases above only ever exercise a new list that is a strict superset of the
  // old one. These three build node lists as literals, since that shape cannot come
  // out of parseSanitizedHtml, to pin the other paths through the index translation
  // and the whitespace-weaving loop in alignNodes.
  const wsNode = (text = '\n'): HtmlNode => ({ kind: 'text', text, ignorable: true });
  const paragraph = (text: string): HtmlNode => ({
    kind: 'element',
    tag: 'p',
    attrs: {},
    children: [{ kind: 'text', text, ignorable: false }],
  });

  it('translates a filtered index back when the old list starts with whitespace the new one lacks', () => {
    const oldNodes = [wsNode(), paragraph('a')];
    const newNodes = [paragraph('a')];
    expect(alignNodes(oldNodes, newNodes)).toEqual([{ old: 1, new: 0 }]);
  });

  it('flushes new-tree whitespace that falls after the last content slot', () => {
    const oldNodes = [paragraph('a')];
    const newNodes = [paragraph('a'), wsNode()];
    expect(alignNodes(oldNodes, newNodes)).toEqual([
      { old: 0, new: 0 },
      { old: null, new: 1 },
    ]);
  });

  it('defers the whitespace flush across an old-only slot instead of dropping it', () => {
    // b has no match in the new list (below the similarity floor), so it comes out
    // old-only. That slot's new side is null, which is the one branch of the weaving
    // loop that skips the flush check entirely. The pending whitespace must still
    // surface on the next slot that does have a new side, not vanish.
    const oldNodes = [paragraph('a'), paragraph('b')];
    const newNodes = [paragraph('a'), wsNode(), paragraph('x')];
    expect(alignNodes(oldNodes, newNodes)).toEqual([
      { old: 0, new: 0 },
      { old: 1, new: null },
      { old: null, new: 1 },
      { old: null, new: 2 },
    ]);
  });
});
