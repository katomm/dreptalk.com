// Pure text transforms behind the Composer's Markdown toolbar buttons.
// Each transform takes the current textarea value plus the selection range and
// returns the new value with the new selection, so the React island stays a
// thin wrapper: read selectionStart/selectionEnd, call applyMarkdown, write back.

export type MarkdownAction =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'quote'
  | 'list'
  | 'orderedList'
  | 'heading';

export interface SelectionState {
  text: string;
  start: number;
  end: number;
}

// Expand a [start, end) selection to the whole lines it spans. Shared by the
// block-level transforms and the Enter-key list continuation so the off-by-one
// boundary math lives in exactly one place.
export function lineBounds(text: string, start: number, end: number): { lineStart: number; lineEnd: number } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = text.length;
  return { lineStart, lineEnd };
}

// Marker pairs for inline wraps.
const INLINE: Record<'bold' | 'italic' | 'strike' | 'code', string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
};

// Line prefixes for block-level toggles.
const PREFIX: Record<'quote' | 'list' | 'heading', string> = {
  quote: '> ',
  list: '- ',
  heading: '## ',
};

export function applyMarkdown(state: SelectionState, action: MarkdownAction): SelectionState {
  switch (action) {
    case 'bold':
    case 'italic':
    case 'strike':
    case 'code':
      return wrapInline(state, INLINE[action]);
    case 'link':
      return insertLink(state);
    case 'quote':
    case 'list':
    case 'heading':
      return prefixLines(state, PREFIX[action]);
    case 'orderedList':
      return orderedList(state);
  }
}

// Wrap (or unwrap, if already wrapped) the selection in a marker like ** or `.
function wrapInline(state: SelectionState, marker: string): SelectionState {
  const { text, start, end } = state;
  const selected = text.slice(start, end);
  const len = marker.length;

  // Already wrapped just inside the selection -> toggle off.
  const before = text.slice(start - len, start);
  const after = text.slice(end, end + len);
  if (before === marker && after === marker) {
    return {
      text: text.slice(0, start - len) + selected + text.slice(end + len),
      start: start - len,
      end: end - len,
    };
  }

  const wrapped = marker + selected + marker;
  const next = text.slice(0, start) + wrapped + text.slice(end);
  if (selected.length === 0) {
    // Empty selection: drop the cursor between the markers.
    return { text: next, start: start + len, end: start + len };
  }
  // Keep the original text selected, now sitting inside the markers.
  return { text: next, start: start + len, end: end + len };
}

// Insert a [text](url) link. With a selection, the selection becomes the link
// text and the "url" placeholder is selected; empty, the "text" placeholder is.
function insertLink(state: SelectionState): SelectionState {
  const { text, start, end } = state;
  const selected = text.slice(start, end);

  if (selected.length === 0) {
    const snippet = '[text](url)';
    const next = text.slice(0, start) + snippet + text.slice(end);
    return { text: next, start: start + 1, end: start + 5 }; // select "text"
  }

  const snippet = `[${selected}](url)`;
  const next = text.slice(0, start) + snippet + text.slice(end);
  const urlStart = start + selected.length + 3; // past "[selected]("
  return { text: next, start: urlStart, end: urlStart + 3 }; // select "url"
}

// Apply a per-line transform across the whole lines a selection spans, toggling
// it off when every line already matches. `detect` reports the on-state, `add`
// and `strip` convert a line each way. Backs both the block-prefix toggles and
// the ordered list so the whole-line machinery lives in one place.
function toggleLines(
  state: SelectionState,
  detect: (line: string) => boolean,
  add: (line: string, i: number) => string,
  strip: (line: string) => string,
): SelectionState {
  const { text } = state;
  const { lineStart, lineEnd } = lineBounds(text, state.start, state.end);
  const lines = text.slice(lineStart, lineEnd).split('\n');
  const on = lines.every(detect);

  const transformed = lines.map((l, i) => (on ? strip(l) : add(l, i))).join('\n');
  const next = text.slice(0, lineStart) + transformed + text.slice(lineEnd);
  return { text: next, start: lineStart, end: lineStart + transformed.length };
}

// Add or remove a line prefix (> , - , ## ) on every line the selection spans.
function prefixLines(state: SelectionState, prefix: string): SelectionState {
  return toggleLines(
    state,
    (l) => l.startsWith(prefix),
    (l) => prefix + l,
    (l) => l.slice(prefix.length),
  );
}

// Number every line the selection spans as "1. ", "2. ", ... or strip the
// numbering when every line is already numbered (toggle off).
const NUMBERED = /^\d+\.\s/;
function orderedList(state: SelectionState): SelectionState {
  return toggleLines(
    state,
    (l) => NUMBERED.test(l),
    (l, i) => `${i + 1}. ${l}`,
    (l) => l.replace(NUMBERED, ''),
  );
}
