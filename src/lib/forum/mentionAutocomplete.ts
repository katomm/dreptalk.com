// Pure logic for the @mention autocomplete in the markdown editor: detecting
// an active mention at the caret, filtering/ranking candidates, and inserting
// the chosen slug. Kept free of DOM/React so it is unit-testable in node.
// The trigger boundary (start / whitespace / '(' / '>') mirrors the shared
// mention syntax contract in src/lib/forum/mentions.ts (MENTION_RE block).

import type { MentionCandidate } from '../db/mentionCandidates.js';

export interface ActiveMention {
  /** Index of the '@' in the text. */
  start: number;
  /** Characters typed after the '@' (may be empty), verbatim case. */
  query: string;
}

export const MAX_SUGGESTIONS = 8;

// Slugs are [a-z0-9-], the typed query also accepts uppercase (filtering is
// case-insensitive, insertion replaces with the canonical slug).
const QUERY_CHAR = /[A-Za-z0-9-]/;
const BOUNDARY = /[\s(>]/;

/** The active mention at the caret, or null when the caret is not in one. */
export function detectMentionQuery(text: string, caret: number): ActiveMention | null {
  let i = caret - 1;
  while (i >= 0 && QUERY_CHAR.test(text[i])) i--;
  if (i < 0 || text[i] !== '@') return null;
  const query = text.slice(i + 1, caret);
  if (query.length > 63) return null;
  if (i > 0 && !BOUNDARY.test(text[i - 1])) return null;
  return { start: i, query };
}

/** Top matches for the query: slug-prefix, then name-prefix, then substring. */
export function filterCandidates(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.toLowerCase();
  if (!q) return candidates.slice(0, MAX_SUGGESTIONS);
  const rank = (cand: MentionCandidate): number => {
    const name = cand.name.toLowerCase();
    if (cand.slug.startsWith(q)) return 0;
    if (name.startsWith(q)) return 1;
    if (cand.slug.includes(q) || name.includes(q)) return 2;
    return -1;
  };
  const ranked: { cand: MentionCandidate; r: number }[] = [];
  for (const cand of candidates) {
    const r = rank(cand);
    if (r >= 0) ranked.push({ cand, r });
  }
  // Stable by construction: Array.prototype.sort is stable, input is name-sorted.
  ranked.sort((a, b) => a.r - b.r);
  return ranked.slice(0, MAX_SUGGESTIONS).map((x) => x.cand);
}

/**
 * Inserts an '@' trigger at the selection so the toolbar's mention button can
 * open the picker the same way typing '@' does. A leading space is added when
 * the caret does not already sit at a mention boundary, so detectMentionQuery
 * recognizes the inserted '@'. Returns the new text, the caret (just after the
 * '@'), and the '@' index for seeding the active mention.
 */
export function insertMentionTrigger(
  text: string,
  start: number,
  end: number,
): { text: string; caret: number; at: number } {
  const needsSpace = start > 0 && !BOUNDARY.test(text[start - 1]);
  const insert = needsSpace ? ' @' : '@';
  const at = start + insert.length - 1;
  return { text: text.slice(0, start) + insert + text.slice(end), caret: at + 1, at };
}

/** Replaces the active mention with the canonical slug and a trailing space. */
export function insertMention(
  text: string,
  active: ActiveMention,
  caret: number,
  slug: string,
): { text: string; caret: number } {
  const inserted = `@${slug} `;
  return {
    text: text.slice(0, active.start) + inserted + text.slice(caret),
    caret: active.start + inserted.length,
  };
}
