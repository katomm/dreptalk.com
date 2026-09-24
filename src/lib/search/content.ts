// Search over the site's own written content: the help guides, the glossary and
// the Governance Review editions. The collections are immutable per deploy and
// small enough to scan in memory, so the worker searches them directly instead
// of shipping an index to the browser or mirroring them into D1. Snippets use
// the same char(1)/char(2) delimiters as the D1 snippet() output so
// parseSnippet renders the highlight identically.

import type { Scope } from './scopes.js';
import { MATCH_END, MATCH_START } from './snippet.js';

export type ContentKind = Extract<Scope, 'help' | 'reviews'>;

export interface ContentDoc {
  kind: ContentKind;
  title: string;
  href: string;
  headings: string[];
  text: string;
  /** Shown in place of a snippet when only the title or a heading matched. */
  description?: string;
  /** Short context next to the title, e.g. "Glossary" or "Epochs 653 to 655". */
  detail?: string;
  /** Tie-break between equally scored docs, newer first (review windows). */
  order?: number;
}

export interface ContentHit {
  title: string;
  href: string;
  detail: string | null;
  snippet: string | null;
  description: string | null;
}

/** A doc with its searchable fields normalized once, at index build time. */
export interface IndexedDoc extends ContentDoc {
  norm: { title: string; headings: string; text: string };
}

const MAX_TOKENS = 8;
// Body occurrences counted per token. Past a handful, more repetitions say
// little about relevance and only cost scan time in the long editions.
const MAX_BODY_COUNT = 10;
// Snippets render on one line cut with an ellipsis, so the match has to sit
// near the start to stay visible on a phone.
const SNIPPET_BEFORE = 24;
const SNIPPET_AFTER = 90;

/** Strips markdown to plain text: drops code, turns links into their text,
 *  removes heading/emphasis/list markers, collapses whitespace. */
export function flattenMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks (review charts too)
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links to their text
    .replace(/^#{1,6}\s+/gm, '') // heading markers
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ') // table separator rows
    .replace(/[*_>#|]/g, ' ') // emphasis, quote, table marks
    .replace(/(^|\s)-(?=\s)/g, '$1') // list bullets, keeping hyphenated words
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pulls ATX heading texts (# .. ######) in document order. */
export function extractHeadings(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split('\n')) {
    const m = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Lowercases and folds diacritics per character, so "Gouvernance" finds
 *  "gouvernance". A character whose folded form is not exactly one character
 *  ("…" decomposes to "...") stays as it is, which keeps the folded text the
 *  same length as the original: a match position in one is the same position
 *  in the other, and snippets cut from the original keep its casing. */
function normalize(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase()).replace(/\P{ASCII}/gu, (ch) => {
    const folded = ch.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return folded.length === ch.length ? folded : ch;
  });
}

function tokenize(q: string): string[] {
  return [...new Set(normalize(q).match(/[a-z0-9]+/g) ?? [])].slice(0, MAX_TOKENS);
}

function isWordChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

/** Positions where tok starts a word in hay, up to max. Matching word starts
 *  (not any substring) keeps "vote" from hitting "devoted", and still lets the
 *  word being typed match as a prefix, like the FTS side's trailing "*". */
function wordStarts(hay: string, tok: string, max: number): number[] {
  const out: number[] = [];
  let i = hay.indexOf(tok);
  while (i >= 0 && out.length < max) {
    if (i === 0 || !isWordChar(hay.charCodeAt(i - 1))) out.push(i);
    i = hay.indexOf(tok, i + 1);
  }
  return out;
}

export function indexContent(docs: ContentDoc[]): IndexedDoc[] {
  return docs.map((d) => ({
    ...d,
    norm: { title: normalize(d.title), headings: normalize(d.headings.join(' \u0000 ')), text: normalize(d.text) },
  }));
}

/** A window of the body around pos with every query token highlighted. */
function snippetAt(doc: IndexedDoc, pos: number, tokens: string[]): string {
  const source = doc.text;
  let start = Math.max(0, pos - SNIPPET_BEFORE);
  // Start on a word boundary so the preview does not open mid-word.
  if (start > 0) {
    const space = source.indexOf(' ', start);
    if (space >= 0 && space < pos) start = space + 1;
  }
  const end = Math.min(source.length, pos + SNIPPET_AFTER);
  const hay = doc.norm.text.slice(start, end);
  const marks: Array<[number, number]> = [];
  for (const tok of tokens) {
    for (const i of wordStarts(hay, tok, Number.POSITIVE_INFINITY)) marks.push([i, i + tok.length]);
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = start > 0 ? '…' : '';
  let at = 0;
  for (const [s, e] of marks) {
    if (s < at) continue; // overlapping token, already inside a mark
    out += `${source.slice(start + at, start + s)}${MATCH_START}${source.slice(start + s, start + e)}${MATCH_END}`;
    at = e;
  }
  out += source.slice(start + at, end);
  return end < source.length ? `${out}…` : out;
}

/** The body position whose snippet window shows the most distinct query
 *  tokens, earliest on a tie. Anchoring on the first token alone opened
 *  "minimum pool fee" on "minimum viable governance" further up the text. */
function bestSnippetPos(bodyHits: number[][]): number | null {
  let best: number | null = null;
  let bestCover = 0;
  for (const p of bodyHits.flat().sort((a, b) => a - b)) {
    const cover = bodyHits.filter((hits) => hits.some((h) => h >= p && h < p + SNIPPET_AFTER)).length;
    if (cover > bestCover) {
      best = p;
      bestCover = cover;
      if (cover === bodyHits.length) break;
    }
  }
  return best;
}

interface Scored {
  doc: IndexedDoc;
  score: number;
  bodyHits: number[][];
}

/** Every doc that contains all query tokens, best first, split by kind. A
 *  token counts in the title (8), a heading (3) or the body (1, plus a little
 *  per repeat). Requiring every token matches the D1 side, where the tokens of
 *  a MATCH expression are ANDed. */
export function searchContent(docs: readonly IndexedDoc[], q: string): Record<ContentKind, ContentHit[]> {
  const out: Record<ContentKind, ContentHit[]> = { help: [], reviews: [] };
  const tokens = tokenize(q);
  if (tokens.length === 0) return out;

  const scored: Scored[] = [];
  for (const doc of docs) {
    let score = 0;
    const bodyHits: number[][] = [];
    let all = true;
    for (const tok of tokens) {
      const inTitle = wordStarts(doc.norm.title, tok, 1).length > 0;
      const inHeadings = wordStarts(doc.norm.headings, tok, 1).length > 0;
      const body = wordStarts(doc.norm.text, tok, MAX_BODY_COUNT);
      if (!inTitle && !inHeadings && body.length === 0) {
        all = false;
        break;
      }
      if (inTitle) score += 8;
      if (inHeadings) score += 3;
      if (body.length > 0) {
        score += 1 + (body.length - 1) * 0.25;
        bodyHits.push(body);
      }
    }
    if (all) scored.push({ doc, score, bodyHits });
  }

  scored.sort((a, b) => b.score - a.score || (b.doc.order ?? 0) - (a.doc.order ?? 0) || a.doc.title.localeCompare(b.doc.title));
  for (const { doc, bodyHits } of scored) {
    const pos = bestSnippetPos(bodyHits);
    const snippet = pos == null ? null : snippetAt(doc, pos, tokens);
    out[doc.kind].push({
      title: doc.title,
      href: doc.href,
      detail: doc.detail ?? null,
      snippet,
      description: snippet ? null : (doc.description ?? null),
    });
  }
  return out;
}
