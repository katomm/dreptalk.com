// Enter-key list continuation for the Composer's Markdown textarea. Pure, so the
// React island stays a thin wrapper: read selectionStart/selectionEnd, call
// continueList, and either write the result back or fall through to a plain
// newline when it returns null. Mirrors the applyMarkdown contract in
// markdownToolbar.ts (SelectionState in, SelectionState out).

import { lineBounds, type SelectionState } from './markdownToolbar.js';

// Ordered item: leading indent, number, then a "." or ")" delimiter with its
// trailing whitespace (one group, since continuation keeps it verbatim).
const ORDERED = /^(\s*)(\d+)([.)]\s+)/;
// Unordered item: leading indent, a -/*/+ bullet, then whitespace. Task-list
// syntax ("- [ ]") is not special-cased: the Markdown renderer strips the
// checkbox input during sanitization, so "[ ]" is treated as ordinary content.
const UNORDERED = /^(\s*)([-*+])(\s+)/;

// The marker a continued item starts with: an unchanged bullet prefix, or the
// ordered prefix with its number incremented.
function continuedMarker(m: RegExpMatchArray, ordered: boolean): string {
  if (!ordered) return m[0];
  return `${m[1]}${Number(m[2]) + 1}${m[3]}`;
}

/**
 * Continues a Markdown list when Enter is pressed inside a list item, or ends
 * the list when the item is empty. Returns the new state, or null when the
 * caret is not in a continuable list item (the caller then inserts a plain
 * newline as usual).
 *
 * - Non-empty item: inserts a newline plus the next marker (ordered numbers
 *   increment, task items reset to unchecked), splitting at the caret.
 * - Empty item (marker only): removes the marker so Enter ends the list.
 * - Only a collapsed caret is handled; a range selection returns null.
 */
export function continueList(state: SelectionState): SelectionState | null {
  const { text, start, end } = state;
  if (start !== end) return null;
  const caret = start;

  const { lineStart, lineEnd } = lineBounds(text, caret, caret);
  const line = text.slice(lineStart, lineEnd);

  const ordered = line.match(ORDERED);
  const unordered = ordered ? null : line.match(UNORDERED);
  const match = ordered ?? unordered;
  if (!match) return null;

  const markerLen = match[0].length;
  const content = line.slice(markerLen);

  // Empty item: Enter clears the marker and ends the list, dropping the caret
  // onto the now-empty line.
  if (content.trim() === '') {
    const next = text.slice(0, lineStart) + text.slice(lineStart + markerLen);
    return { text: next, start: lineStart, end: lineStart };
  }

  // With content, only continue when the caret sits in the content region; a
  // caret still inside the indent or marker falls back to a plain newline.
  if (caret < lineStart + markerLen) return null;

  const marker = continuedMarker(match, ordered !== null);
  const insert = `\n${marker}`;
  const next = text.slice(0, caret) + insert + text.slice(caret);
  const pos = caret + insert.length;
  return { text: next, start: pos, end: pos };
}
