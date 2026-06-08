// Pure text transforms behind the Composer's Markdown toolbar buttons.
// Each transform takes the current textarea value plus the selection range and
// returns the new value with the new selection, so the React island stays a
// thin wrapper: read selectionStart/selectionEnd, call applyMarkdown, write back.

export type MarkdownAction = 'bold' | 'italic' | 'code' | 'link' | 'quote' | 'list' | 'heading';

export interface SelectionState {
  text: string;
  start: number;
  end: number;
}

// Marker pairs for inline wraps.
const INLINE: Record<'bold' | 'italic' | 'code', string> = {
  bold: '**',
  italic: '*',
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
    case 'code':
      return wrapInline(state, INLINE[action]);
    case 'link':
      return insertLink(state);
    case 'quote':
    case 'list':
    case 'heading':
      return prefixLines(state, PREFIX[action]);
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

// Add or remove a line prefix (> , - , ## ) on every line the selection spans.
function prefixLines(state: SelectionState, prefix: string): SelectionState {
  const { text } = state;

  // Expand the range to whole lines.
  const lineStart = text.lastIndexOf('\n', state.start - 1) + 1;
  let lineEnd = text.indexOf('\n', state.end);
  if (lineEnd === -1) lineEnd = text.length;

  const block = text.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const allPrefixed = lines.every((l) => l.startsWith(prefix));

  const transformed = lines
    .map((l) => (allPrefixed ? l.slice(prefix.length) : prefix + l))
    .join('\n');

  const next = text.slice(0, lineStart) + transformed + text.slice(lineEnd);
  return { text: next, start: lineStart, end: lineStart + transformed.length };
}
