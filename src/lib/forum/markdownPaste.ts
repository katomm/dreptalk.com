// Paste-as-link for the Composer's Markdown textarea. When a URL is pasted over
// a non-empty selection, wrap the selection as [selection](url) instead of
// replacing it. Pure, mirroring the applyMarkdown contract in markdownToolbar.ts.

import type { SelectionState } from './markdownToolbar.js';

// A single http(s) URL with no internal whitespace. Deliberately strict so a
// pasted paragraph that merely starts with "http" is not mistaken for a link.
const URL_RE = /^https?:\/\/\S+$/i;

/**
 * Wraps the selection as a Markdown link when a URL is pasted over it. Returns
 * the new state with the caret placed after the inserted link, or null when the
 * paste should proceed normally (no selection, or the clipboard is not a single
 * URL).
 */
export function linkFromPaste(state: SelectionState, pasted: string): SelectionState | null {
  const { text, start, end } = state;
  if (start === end) return null;

  const url = pasted.trim();
  if (!URL_RE.test(url)) return null;

  const selected = text.slice(start, end);
  const snippet = `[${selected}](${url})`;
  const next = text.slice(0, start) + snippet + text.slice(end);
  const pos = start + snippet.length;
  return { text: next, start: pos, end: pos };
}
