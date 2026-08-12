// Pairs two node lists into an ordered slot list the diff can walk once.
//
// Two stages. Stage one is an LCS on a strict key (tag plus normalized text), which
// gives anchors that are certainly the same node. Stage two pairs leftovers by word
// similarity, but only WITHIN a gap between two anchors. Letting stage two reach
// across an anchor breaks monotonicity: given A,B against B,A it would pair both
// nodes, the move would render as no change at all, and a renderer walking both
// lists in order would emit nodes twice or out of order. Confining it to gaps keeps
// the pairing strictly increasing on both sides, which is the invariant the diff
// renderer depends on.

import type { HtmlNode } from './htmlNodes.js';
import { nodeText } from './htmlNodes.js';
import { similarity } from './wordDiff.js';

/** One output position: a pair, an old-only node, or a new-only node. */
export type Slot = { old: number | null; new: number | null };

// Below this, two nodes are a replacement rather than a rewrite. Shared with the
// markdown source view.
const SIMILAR_ENOUGH = 0.3;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

function strictKey(node: HtmlNode): string {
  if (node.kind === 'text') return `t:${norm(node.text)}`;
  if (node.kind === 'void') return `v:${node.tag}`;
  return `e:${node.tag}:${norm(nodeText(node))}`;
}

function sameShape(a: HtmlNode, b: HtmlNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'element' && b.kind === 'element') return a.tag === b.tag;
  return a.kind === 'text';
}

/** Greedy left-to-right similarity pairing inside one gap. Stays monotonic. */
function pairGap(
  oldNodes: HtmlNode[],
  newNodes: HtmlNode[],
  oldFrom: number,
  oldTo: number,
  newFrom: number,
  newTo: number,
): Slot[] {
  const slots: Slot[] = [];
  let oi = oldFrom;
  let nj = newFrom;

  while (oi < oldTo && nj < newTo) {
    let best = -1;
    let bestScore = SIMILAR_ENOUGH;
    for (let k = nj; k < newTo; k++) {
      if (!sameShape(oldNodes[oi], newNodes[k])) continue;
      const score = similarity(nodeText(oldNodes[oi]), nodeText(newNodes[k]));
      if (score >= bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (best === -1) {
      slots.push({ old: oi, new: null });
      oi++;
      continue;
    }
    // Everything before the partner is an insertion.
    for (; nj < best; nj++) slots.push({ old: null, new: nj });
    slots.push({ old: oi, new: nj });
    oi++;
    nj++;
  }
  for (; oi < oldTo; oi++) slots.push({ old: oi, new: null });
  for (; nj < newTo; nj++) slots.push({ old: null, new: nj });
  return slots;
}

const isIgnorable = (node: HtmlNode): boolean => node.kind === 'text' && node.ignorable;

/**
 * Aligns two node lists into output order. Indices strictly increase on both sides.
 *
 * Structural whitespace never reaches the matcher: every layout newline normalizes to
 * the same key, so a two-item list would offer three identical candidates and the LCS
 * would anchor on layout instead of on the items. The new tree's whitespace is passed
 * through in place, the old tree's is dropped, since the new layout is what renders.
 */
export function alignNodes(oldNodes: HtmlNode[], newNodes: HtmlNode[]): Slot[] {
  const oldIdx = oldNodes.map((_, i) => i).filter((i) => !isIgnorable(oldNodes[i]));
  const newIdx = newNodes.map((_, i) => i).filter((i) => !isIgnorable(newNodes[i]));
  const oldContent = oldIdx.map((i) => oldNodes[i]);
  const newContent = newIdx.map((i) => newNodes[i]);

  const contentSlots = alignContent(oldContent, newContent);

  // Translate back to original indices and weave the new tree's whitespace back in,
  // keeping both sides monotonic.
  const whitespace = newNodes.map((_, i) => i).filter((i) => isIgnorable(newNodes[i]));
  const slots: Slot[] = [];
  let w = 0;
  for (const slot of contentSlots) {
    const newOriginal = slot.new === null ? null : newIdx[slot.new];
    if (newOriginal !== null) {
      while (w < whitespace.length && whitespace[w] < newOriginal) {
        slots.push({ old: null, new: whitespace[w++] });
      }
    }
    slots.push({ old: slot.old === null ? null : oldIdx[slot.old], new: newOriginal });
  }
  while (w < whitespace.length) slots.push({ old: null, new: whitespace[w++] });
  return slots;
}

/** The matcher proper, over content nodes only. Indices are positions in its inputs. */
function alignContent(oldNodes: HtmlNode[], newNodes: HtmlNode[]): Slot[] {
  const a = oldNodes.map(strictKey);
  const b = newNodes.map(strictKey);
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const anchors: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      anchors.push([i, j]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }

  const slots: Slot[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const [oi, nj] of anchors) {
    slots.push(...pairGap(oldNodes, newNodes, oldCursor, oi, newCursor, nj));
    slots.push({ old: oi, new: nj });
    oldCursor = oi + 1;
    newCursor = nj + 1;
  }
  slots.push(...pairGap(oldNodes, newNodes, oldCursor, n, newCursor, m));
  return slots;
}
