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
// is a <span> around a changed run of words inside a text node, and even that is
// withheld inside ul, ol, table, thead, tbody and tr, see NO_SPAN_PARENTS below.

import { BLOCK_TAGS, DIFF_CLASSES } from '../sanitizedHtmlGrammar.js';
import { alignNodes } from './alignNodes.js';
import type { Slot } from './alignNodes.js';
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

// Checked against DIFF_CLASSES (the one list of classes this module may emit, shared
// with the test's grammar check) so a typo or a forgotten update to that list fails
// loudly here instead of only showing up as a silent mismatch in a test elsewhere.
function diffClass(name: string): string {
  if (!DIFF_CLASSES.has(name)) throw new Error(`htmlDiff: "${name}" is not in DIFF_CLASSES`);
  return name;
}

// True for two nodes that could stand in for each other: same node kind, and for
// elements or void tags, the same tag. Used only to decide the single-candidate
// pairing in diffNodeLists, where there is already exactly one node on each side and
// nothing else it could be weighed against. Deliberately not called sameShape: that
// name is also alignNodes' own internal helper, with a different answer for two void
// nodes of the same tag (alignNodes never matches those outside its strict-key stage,
// since its job is choosing among several textual candidates and a void node has no
// text to compare). This one is only ever invoked when there is no choice to make, so
// matching same-tag voids here is correct and intentionally not the same rule.
function canPairAsSoleCandidate(a: HtmlNode, b: HtmlNode): boolean {
  if (a.kind === 'text' && b.kind === 'text') return true;
  if (a.kind === 'element' && b.kind === 'element') return a.tag === b.tag;
  if (a.kind === 'void' && b.kind === 'void') return a.tag === b.tag;
  return false;
}

// Wraps the changed core of a word-diff or whole-node text run in a marker span,
// keeping any leading or trailing whitespace outside it. wordDiff can merge a
// boundary space into an add/del run (inserting " changed" after an unchanged
// word), and a whole added/removed text node can carry structural whitespace at its
// edges. The true reason to trim rather than wrap the whole run: a test asserts the
// literal string `<span class="diff-add">changed</span>`, and a leading space inside
// the span would not match it. It is also just the more legible rendering: a reader
// should not see a highlight that starts mid-space.
function wrapWord(kind: 'add' | 'del', text: string): string {
  if (text.trim() === '') return text;
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  const trailing = /\s*$/.exec(text)?.[0] ?? '';
  const core = text.slice(leading.length, text.length - trailing.length);
  return `${leading}<span class="${diffClass(`diff-${kind}`)}">${core}</span>${trailing}`;
}

// Serializes a whole subtree with one marker class on its outermost element.
function markWhole(node: HtmlNode, kind: 'add' | 'del'): string {
  if (node.kind === 'text') return wrapWord(kind, node.text);
  if (node.kind === 'void') return `<${node.tag}>`;
  const cls = diffClass(BLOCK_TAGS.has(node.tag) ? `diff-block-${kind}` : `diff-${kind}`);
  return `<${node.tag}${attrString(node.attrs)} class="${cls}">${serializeNodes(node.children)}</${node.tag}>`;
}

// Containers whose content model has no room for a marker span as a direct child.
// renderMarkdown passes raw HTML blocks through largely unchecked, so a stored body
// can already hold text that never belonged directly inside one of these to begin
// with (`<ul>alpha<li>x</li></ul>`), and the diff must not compound that by adding a
// <span>, which is not legal content there either. The two families of tags here fail
// differently in a browser: inside table, thead, tbody or tr, the HTML parser
// foster-parents anything that is not table markup out of the table entirely, so a
// wrapped span there would risk the marked words rendering before the table rather
// than inside it. Inside ul or ol a browser is more forgiving and keeps a stray span
// right where it was written, so nothing relocates, it would just be invalid content
// model rather than a rendering hazard. Both are still refused here: the module's own
// invariant is no wrapper outside a text node, not "no wrapper unless the browser
// happens to tolerate it". blockquote is deliberately not in this list: its content
// model tolerates a span child, this is only about the strict list and table
// containers whose only legal element child is li, tr, thead or tbody.
//
// The word is still counted at every call site that checks this guard (the old-only
// and new-only branches in diffNodeLists, and diffText's own branch below for when
// alignNodes pairs the old and new text directly): a reader who sees "edited" with a
// count is told something happened even where the module declines to show what.
// Leaving it uncounted was the other option on the table, and was rejected because a
// reader seeing "edited" with no marks and a zero count has been told nothing changed
// at all, which is worse than an accurate count with no visible marker to match it.
const NO_SPAN_PARENTS: ReadonlySet<string> = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tr']);

function diffText(oldText: string, newText: string, counts: Counts, parentTag: string | null): string {
  const ops = wordDiff(oldText, newText);
  if (parentTag !== null && NO_SPAN_PARENTS.has(parentTag)) {
    // Marking is withheld here, not counting: a span would break the container's
    // content model (see NO_SPAN_PARENTS), but the words still changed and the
    // header should say so. Walk the diff purely for its counts, same rule as
    // everywhere else, and return the new text plain, no wrapping at all.
    for (const op of ops) {
      if (op.type === 'add') counts.added += countWords(op.text);
      if (op.type === 'del') counts.removed += countWords(op.text);
    }
    return newText;
  }
  return ops
    .map((op) => {
      if (op.type === 'same') return op.text;
      if (op.type === 'add') counts.added += countWords(op.text);
      else counts.removed += countWords(op.text);
      return wrapWord(op.type, op.text);
    })
    .join('');
}

const isContent = (node: HtmlNode): boolean => !(node.kind === 'text' && node.ignorable);

// Looks ahead from an old-only slot for the new-only slot it might be a whole-node
// replacement for: only structural whitespace passthrough slots are allowed in
// between, and the first non-whitespace new-only slot found is the candidate,
// whether or not its text ends up matching. A matched slot, or the end of the list,
// ends the run with no candidate.
function findWholeReplacement(
  slots: Slot[],
  i: number,
  newNodes: HtmlNode[],
): { node: HtmlNode; between: string[] } | null {
  const between: string[] = [];
  let j = i + 1;
  while (j < slots.length) {
    // Read into locals so TypeScript can narrow newIndex through the checks below:
    // slots[j].new stays a `number | null` property access even right after a
    // `!== null` check on the same expression, since j is a mutable loop variable
    // and slots is a plain array, nothing ties the checked value to the one read a
    // moment later. A local const does not have that problem.
    const slot = slots[j];
    const newIndex = slot.new;
    if (slot.old !== null || newIndex === null) break;
    const candidate = newNodes[newIndex];
    if (candidate.kind === 'text' && candidate.ignorable) {
      between.push(candidate.text);
      j++;
      continue;
    }
    return { node: candidate, between };
  }
  return null;
}

// Cells inside one row, zipped by column. See the tr branch in diffNodeLists.
function diffRowCells(oldNodes: HtmlNode[], newNodes: HtmlNode[], counts: Counts): string {
  // tr is in NO_SPAN_PARENTS, so a text node directly inside the row never carries a
  // marker: the new value is shown plain and the old one is dropped from the markup,
  // both still counted, the same rule diffNodeLists applies elsewhere.
  const added = (node: HtmlNode): string => {
    counts.added += countWords(nodeText(node));
    return node.kind === 'text' ? node.text : markWhole(node, 'add');
  };
  const removed = (node: HtmlNode): string => {
    counts.removed += countWords(nodeText(node));
    return node.kind === 'text' ? '' : markWhole(node, 'del');
  };

  const oldCells = oldNodes.filter(isContent);
  const parts: string[] = [];
  let column = 0;
  for (const node of newNodes) {
    if (node.kind === 'text' && node.ignorable) {
      parts.push(node.text); // structural whitespace of the new tree, passed through
      continue;
    }
    const oldCell = oldCells[column++];
    if (oldCell && canPairAsSoleCandidate(oldCell, node)) {
      parts.push(diffNode(oldCell, node, counts, 'tr'));
      continue;
    }
    // A th where there was a td, or the row grew a column: no pair for this position.
    if (oldCell) parts.push(removed(oldCell));
    parts.push(added(node));
  }
  // A column the new row no longer has, shown as a trailing deleted cell.
  for (; column < oldCells.length; column++) parts.push(removed(oldCells[column]));
  return parts.join('');
}

function diffNodeLists(oldNodes: HtmlNode[], newNodes: HtmlNode[], counts: Counts, parentTag: string | null): string {
  // Cells are positional: the nth cell of a row is the nth column whatever its text
  // says, so inside a tr the pairing is a zip by index and nothing else. alignNodes
  // would ask its own question instead, which is the wrong one here: rewriting a cell
  // from "80k" to "90k" shares no words, lands under the 0.3 similarity threshold and
  // comes back as a replacement, so the row renders a deleted cell next to an added
  // one and the reader sees a stray extra column. Every number, date or one-word
  // status in a table hits that. The fix belongs here rather than in alignNodes: this
  // is a property of the container, and alignNodes has no parent context and no
  // business knowing tag names, its contract is choosing among several textual
  // candidates.
  if (parentTag === 'tr') return diffRowCells(oldNodes, newNodes, counts);

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
  //
  // This rule is scoped to "exactly one candidate on each side", not to "the parent
  // is already paired", so its effect depends on whether a sibling happens to exist.
  // A lone `<p>Alpha beta gamma</p>` rewritten to `<p>Totally unrelated words</p>`
  // takes this branch (one child each side) and comes out as a word-level diff. The
  // same rewrite with an unchanged sibling paragraph does not (two children each
  // side, so alignNodes runs its own multi-candidate similarity match, which still
  // rejects the pair at 0% overlap and replaces the paragraph whole). Both outcomes
  // are correct for what each is actually deciding: eliminating the one alternative
  // is not the same operation as choosing among several, and only the latter is
  // alignNodes' job. The asymmetry is a known, accepted consequence, pinned by two
  // tests below so a later change cannot silently flip either behaviour.
  const oldContent = oldNodes.filter(isContent);
  const newContent = newNodes.filter(isContent);
  if (oldContent.length === 1 && newContent.length === 1 && canPairAsSoleCandidate(oldContent[0], newContent[0])) {
    const parts: string[] = [];
    for (const node of newNodes) {
      if (node === newContent[0]) {
        parts.push(diffNode(oldContent[0], node, counts, parentTag));
        continue;
      }
      if (node.kind !== 'text') {
        // newContent is exactly the one non-ignorable node in newNodes by
        // construction; anything else reaching here is one of the ignorable
        // whitespace nodes filtered out of it, never an element or void node.
        throw new Error('diffNodeLists: expected only ignorable whitespace beside the sole content node');
      }
      parts.push(node.text);
    }
    return parts.join('');
  }

  const slots = alignNodes(oldNodes, newNodes);
  const out: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    // Read into locals so TypeScript can narrow them through the checks below: after
    // eliminating "both sides present" and "new side present", what remains is not
    // "old side present" as a matter of the Slot type, only "new side absent", since
    // Slot does not itself forbid a slot with both sides null (alignNodes guarantees
    // that at runtime, but the type does not encode it). The explicit oldIndex ===
    // null check further down covers that case rather than asserting it away.
    const slot = slots[i];
    const oldIndex = slot.old;
    const newIndex = slot.new;
    if (oldIndex !== null && newIndex !== null) {
      out.push(diffNode(oldNodes[oldIndex], newNodes[newIndex], counts, parentTag));
      continue;
    }
    if (newIndex !== null) {
      const node = newNodes[newIndex];
      counts.added += countWords(nodeText(node));
      if (node.kind === 'text' && parentTag !== null && NO_SPAN_PARENTS.has(parentTag)) {
        out.push(node.text); // already-invalid content in this position; show the new value unmarked, still counted
      } else {
        out.push(markWhole(node, 'add'));
      }
      continue;
    }
    if (oldIndex === null) {
      continue; // both sides null: alignNodes never actually produces this, nothing to do if it did
    }

    const oldNode = oldNodes[oldIndex];
    if (oldNode.kind === 'text' && parentTag !== null && NO_SPAN_PARENTS.has(parentTag)) {
      counts.removed += countWords(nodeText(oldNode));
      continue; // dropped from the markup; see NO_SPAN_PARENTS, still counted
    }

    // A whole-node deletion immediately followed by a whole-node insertion (only
    // structural whitespace passthrough allowed in between) is the two halves of one
    // replacement, not two independent edits. When their text is byte-identical (a
    // block tag swapped, e.g. <h2> to <h3>, or a list type swapped with the same
    // items), no word was actually written or removed, so neither side counts.
    const replacement = findWholeReplacement(slots, i, newNodes);
    if (replacement && nodeText(oldNode) === nodeText(replacement.node)) {
      const addOutput =
        replacement.node.kind === 'text' && parentTag !== null && NO_SPAN_PARENTS.has(parentTag)
          ? replacement.node.text
          : markWhole(replacement.node, 'add');
      out.push(markWhole(oldNode, 'del'), ...replacement.between, addOutput);
      i += replacement.between.length + 1; // skip the consumed whitespace and the matched new-only slot
      continue;
    }

    counts.removed += countWords(nodeText(oldNode));
    out.push(markWhole(oldNode, 'del'));
  }
  return out.join('');
}

// A prose block whose visible text is unchanged but whose inline structure moved:
// formatting was added or removed. Not an edit to what the post says, so the block
// is marked quietly and counts no words. Restricted to prose blocks: doing this on
// a ul or a table would hide a real structural change.
const META_SHORTCUT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'li', 'td', 'th']);

function diffNode(oldNode: HtmlNode, newNode: HtmlNode, counts: Counts, parentTag: string | null): string {
  if (oldNode.kind === 'text' && newNode.kind === 'text') {
    return diffText(oldNode.text, newNode.text, counts, parentTag);
  }
  if (oldNode.kind === 'void' || newNode.kind === 'void') {
    return serializeNodes([newNode]);
  }
  if (oldNode.kind !== 'element' || newNode.kind !== 'element' || oldNode.tag !== newNode.tag) {
    // Every call site pairs nodes of matching kind and tag before reaching diffNode:
    // alignNodes never pairs mismatched tags or two different void tags (both are
    // pinned by alignNodes.test.ts), and the single-candidate branch above checks
    // canPairAsSoleCandidate itself. Proven unreachable by patching this branch to
    // throw and running the full forum suite (267 tests, all still green) before
    // this fix. Kept as a thrown invariant rather than deleted outright: removing it
    // would leave the type checker unable to narrow oldNode/newNode to 'element' for
    // the code below, and throwing fails loudly if a future caller ever breaks the
    // guarantee, instead of silently drifting back into whatever this used to cover.
    throw new Error('diffNode: unreachable, callers guarantee matching kind and tag');
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
  const inner = diffNodeLists(oldNode.children, newNode.children, trial, newNode.tag);

  if (META_SHORTCUT_TAGS.has(newNode.tag) && sameText && (trial.added > 0 || trial.removed > 0)) {
    return `<${newNode.tag}${attrString(newNode.attrs)} class="${diffClass('diff-meta')}">${serializeNodes(newNode.children)}</${newNode.tag}>`;
  }

  counts.added += trial.added;
  counts.removed += trial.removed;
  // Same element, different attributes (a link whose target moved): the text is
  // unchanged so this is not an add or a remove, but it must still be visible.
  const cls = attrsChanged ? ` class="${diffClass('diff-meta')}"` : '';
  return `<${newNode.tag}${attrString(newNode.attrs)}${cls}>${inner}</${newNode.tag}>`;
}

/** Diffs two sanitized post bodies into marked HTML plus word-level change stats. */
export function richDiff(oldHtml: string, newHtml: string): RichDiff {
  if (oldHtml === newHtml) {
    // The one path that would otherwise hand back stored HTML the parser never saw.
    // Not exploitable today, no writer can get a script tag into body_html, but it is
    // reachable: for a post whose stored body is malformed, every other version pair
    // degrades and this one alone would render the raw body. Parse purely to validate,
    // then return the original string, never a re-serialization of it.
    try {
      parseSanitizedHtml(newHtml);
    } catch {
      return { html: '', added: 0, removed: 0, changed: false, degraded: true };
    }
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
  const html = diffNodeLists(oldNodes, newNodes, counts, null);
  return { html, added: counts.added, removed: counts.removed, changed: true, degraded: false };
}
