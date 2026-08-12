// Rich diff over two sanitized post bodies: parse both into node trees, walk them
// recursively marking what changed, serialize the marked tree back to HTML.
//
// Why a tree and not a token stream: a flat LCS with tags as tokens cannot see
// parent/child relationships. With several identical <li> tokens it pairs
// structurally unrelated tags, and it has no answer for an <a> whose href moved
// while its text stayed put. Serializing from a tree also makes correct nesting
// structural rather than something the renderer has to be careful about.
//
// Markers are classes on the element itself, never a wrapper: wrapping an <li>
// would make the surrounding <ul> invalid. Stored body_html never contains class,
// so these cannot collide with post content. The only element this module invents
// is a <span> around a changed run of words inside a text node.

import { BLOCK_TAGS } from '../sanitizedHtmlGrammar.js';
import { alignNodes } from './alignNodes.js';
import { type HtmlNode, nodeText, parseSanitizedHtml, serializeNodes } from './htmlNodes.js';
import { wordDiff } from './wordDiff.js';

export interface RichDiff {
  html: string;
  /** Words added, ignoring formatting-only and link-target changes. */
  added: number;
  /** Words removed, same rule. */
  removed: number;
  /** False only when the two inputs are byte-identical. */
  changed: boolean;
  /**
   * True when a stored body could not be parsed, so no rich diff exists for this
   * pair. html is empty in that case and the caller must fall back to the source
   * view, which needs no parser.
   */
  degraded: boolean;
}

interface Counts {
  added: number;
  removed: number;
}

const countWords = (text: string): number => (text.match(/[^\s]+/g) ?? []).length;

const attrString = (attrs: Record<string, string>): string =>
  Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');

function attrsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

// True for two nodes that could stand in for each other: same node kind, and for
// elements or void tags, the same tag. Used only to decide the single-candidate
// pairing below, not by alignNodes' own multi-candidate similarity matching.
function sameShape(a: HtmlNode, b: HtmlNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'text') return true;
  return a.tag === b.tag;
}

// Wraps the changed core of a word-diff or whole-node text run in a marker span,
// keeping any leading or trailing whitespace outside it. wordDiff can merge a
// boundary space into an add/del run (inserting " changed" after an unchanged
// word), and a whole added/removed text node can carry structural whitespace at its
// edges. Marking the whitespace itself would look no different to a reader, and it
// would also break `expectValidDiffOutput`'s span-stripping regex, which only
// tolerates a class attribute directly on a span holding non-tag text.
function wrapWord(kind: 'add' | 'del', text: string): string {
  if (text.trim() === '') return text;
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  const trailing = /\s*$/.exec(text)?.[0] ?? '';
  const core = text.slice(leading.length, text.length - trailing.length);
  return `${leading}<span class="diff-${kind}">${core}</span>${trailing}`;
}

// Serializes a whole subtree with one marker class on its outermost element.
function markWhole(node: HtmlNode, kind: 'add' | 'del'): string {
  if (node.kind === 'text') return wrapWord(kind, node.text);
  if (node.kind === 'void') return `<${node.tag}>`;
  const cls = BLOCK_TAGS.has(node.tag) ? `diff-block-${kind}` : `diff-${kind}`;
  return `<${node.tag}${attrString(node.attrs)} class="${cls}">${serializeNodes(node.children)}</${node.tag}>`;
}

function diffText(oldText: string, newText: string, counts: Counts): string {
  return wordDiff(oldText, newText)
    .map((op) => {
      if (op.type === 'same') return op.text;
      if (op.type === 'add') counts.added += countWords(op.text);
      else counts.removed += countWords(op.text);
      return wrapWord(op.type, op.text);
    })
    .join('');
}

const isContent = (node: HtmlNode): boolean => !(node.kind === 'text' && node.ignorable);

function diffNodeLists(oldNodes: HtmlNode[], newNodes: HtmlNode[], counts: Counts): string {
  // A container with exactly one real (non-whitespace) child on each side, of
  // matching shape, is structurally unambiguous: there is no other candidate on
  // either side it could be weighed against. alignNodes' similarity threshold exists
  // to choose among several candidates, and rejects a pair outright once their text
  // shares no words, which a table cell rewritten to unrelated words does at every
  // level on the way down (table, tbody, tr, td all inherit the cell's own 0%
  // score, since nodeText is the whole subtree's text). Left to alignNodes alone,
  // that replaces the whole table instead of descending into the one changed cell.
  // Pairing the sole candidates directly here, and passing the new side's structural
  // whitespace through untouched, is what lets the diff still recurse down to a
  // word-level change on the cell text.
  const oldContent = oldNodes.filter(isContent);
  const newContent = newNodes.filter(isContent);
  if (oldContent.length === 1 && newContent.length === 1 && sameShape(oldContent[0], newContent[0])) {
    return newNodes
      .map((node) =>
        node === newContent[0] ? diffNode(oldContent[0], node, counts) : node.kind === 'text' ? node.text : '',
      )
      .join('');
  }

  const out: string[] = [];
  for (const slot of alignNodes(oldNodes, newNodes)) {
    if (slot.old !== null && slot.new !== null) {
      out.push(diffNode(oldNodes[slot.old], newNodes[slot.new], counts));
    } else if (slot.new !== null) {
      const node = newNodes[slot.new];
      counts.added += countWords(nodeText(node));
      out.push(markWhole(node, 'add'));
    } else if (slot.old !== null) {
      const node = oldNodes[slot.old];
      counts.removed += countWords(nodeText(node));
      out.push(markWhole(node, 'del'));
    }
  }
  return out.join('');
}

// A prose block whose visible text is unchanged but whose inline structure moved:
// formatting was added or removed. Not an edit to what the post says, so the block
// is marked quietly and counts no words. Restricted to prose blocks: doing this on
// a ul or a table would hide a real structural change.
const META_SHORTCUT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'li', 'td', 'th']);

function diffNode(oldNode: HtmlNode, newNode: HtmlNode, counts: Counts): string {
  if (oldNode.kind === 'text' && newNode.kind === 'text') {
    return diffText(oldNode.text, newNode.text, counts);
  }
  if (oldNode.kind === 'void' || newNode.kind === 'void') {
    return serializeNodes([newNode]);
  }
  if (oldNode.kind !== 'element' || newNode.kind !== 'element' || oldNode.tag !== newNode.tag) {
    counts.removed += countWords(nodeText(oldNode));
    counts.added += countWords(nodeText(newNode));
    return markWhole(oldNode, 'del') + markWhole(newNode, 'add');
  }

  // Whitespace is meaningful inside pre, so a changed code block is replaced whole.
  if (newNode.tag === 'pre') {
    if (nodeText(oldNode) === nodeText(newNode)) return serializeNodes([newNode]);
    counts.removed += countWords(nodeText(oldNode));
    counts.added += countWords(nodeText(newNode));
    return markWhole(oldNode, 'del') + markWhole(newNode, 'add');
  }

  const attrsChanged = !attrsEqual(oldNode.attrs, newNode.attrs);
  const sameText = nodeText(oldNode) === nodeText(newNode);

  // Run the recursive diff into a scratch counter first, in both cases, so a
  // meta-shortcut candidate is decided by its actual result rather than a guess.
  // sameText alone cannot tell "formatting moved" (recursion finds nothing to
  // attribute at word level, e.g. only an href changed on a matched <a>) apart from
  // "the words are the same but nothing lines up" (an inline element wrapped part of
  // the text, so the recursion pairs nothing and reports a full add plus a full
  // remove even though the visible text did not change). Only the second case should
  // fall back to marking the whole block: the first is already precise.
  const trial: Counts = { added: 0, removed: 0 };
  const inner = diffNodeLists(oldNode.children, newNode.children, trial);

  if (META_SHORTCUT_TAGS.has(newNode.tag) && sameText && (trial.added > 0 || trial.removed > 0)) {
    return `<${newNode.tag}${attrString(newNode.attrs)} class="diff-meta">${serializeNodes(newNode.children)}</${newNode.tag}>`;
  }

  counts.added += trial.added;
  counts.removed += trial.removed;
  // Same element, different attributes (a link whose target moved): the text is
  // unchanged so this is not an add or a remove, but it must still be visible.
  const cls = attrsChanged ? ' class="diff-meta"' : '';
  return `<${newNode.tag}${attrString(newNode.attrs)}${cls}>${inner}</${newNode.tag}>`;
}

/** Diffs two sanitized post bodies into marked HTML plus word-level change stats. */
export function richDiff(oldHtml: string, newHtml: string): RichDiff {
  if (oldHtml === newHtml) {
    return { html: newHtml, added: 0, removed: 0, changed: false, degraded: false };
  }
  const counts: Counts = { added: 0, removed: 0 };
  let oldNodes: HtmlNode[];
  let newNodes: HtmlNode[];
  try {
    oldNodes = parseSanitizedHtml(oldHtml);
    newNodes = parseSanitizedHtml(newHtml);
  } catch {
    // A stored body outside the sanitizer grammar. The parser is right to refuse it,
    // but one damaged row must not take down the whole history view, so this degrades
    // to the source view rather than throwing. Deliberately no fallback to rendering
    // the raw body: it is exactly the string we just failed to validate.
    return { html: '', added: 0, removed: 0, changed: true, degraded: true };
  }
  const html = diffNodeLists(oldNodes, newNodes, counts);
  return { html, added: counts.added, removed: counts.removed, changed: true, degraded: false };
}
