import { describe, it, expect } from 'vitest';
import { alignNodes } from './alignNodes.js';
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
    // Similarity must not reach across an anchor, or the move vanishes.
    const slots = alignNodes(p('<p>A</p><p>B</p>'), p('<p>B</p><p>A</p>'));
    const paired = slots.filter((s) => s.old !== null && s.new !== null);
    expect(paired).toHaveLength(1);
    expect(slots.filter((s) => s.old === null)).toHaveLength(1);
    expect(slots.filter((s) => s.new === null)).toHaveLength(1);
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
    expect(slots.filter((s) => s.old !== null).map((s) => s.old).sort()).toEqual([0, 1, 2]);
    expect(slots.filter((s) => s.new !== null).map((s) => s.new).sort()).toEqual([0, 1, 2]);
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
});
