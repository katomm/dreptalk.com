// Snippet handling for search results. The API returns plain text in which
// matched terms are wrapped in U+0001 / U+0002 control characters (set by
// FTS5 snippet() on the server). The client splits on the markers and renders
// <mark> elements; no HTML ever crosses the API boundary, so source text is
// inert by construction.

export interface SnippetSegment {
  text: string;
  match: boolean;
}

const MATCH_START = '\u0001';
const MATCH_END = '\u0002';

/** Splits marked snippet text into ordered segments for rendering. */
export function parseSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let match = false;
  let buffer = '';
  for (const ch of snippet) {
    if (ch === MATCH_START || ch === MATCH_END) {
      if (buffer) segments.push({ text: buffer, match });
      buffer = '';
      match = ch === MATCH_START;
    } else {
      buffer += ch;
    }
  }
  if (buffer) segments.push({ text: buffer, match });
  return segments;
}

/**
 * Light cleanup for snippets cut from raw markdown: leading heading/list/quote
 * markers and inline emphasis characters read as noise in a one-line preview.
 * Two-step leading cleanup: first strip whitespace/heading/blockquote chars,
 * then strip a list marker (- or *) only when followed by whitespace, so a
 * leading hyphen that is part of a word (e.g. '-based') is preserved.
 * Operates before parseSnippet and must not remove the match markers.
 */
export function cleanMarkdownSnippet(s: string): string {
  return s
    .replace(/^[\s#>]+/, '')
    .replace(/^[*-]\s+/, '')
    .replace(/(\*\*|__|`)/g, '')
    .trim();
}
