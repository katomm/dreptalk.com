// The one definition of what stored post HTML may contain.
//
// Two consumers: the sanitizer in src/lib/markdown.ts builds its xss whitelist from
// ALLOWED_TAGS, and the diff parser in src/lib/forum/htmlNodes.ts refuses anything
// outside it. The diff's safety argument is that its input can only ever be what the
// sanitizer produced, so these must be the same list and not two lists kept in step
// by hand. This module has no imports on purpose: it is pulled into the browser
// bundle by the history modal, and must not drag marked or xss along with it.

/** Tag to allowed attribute names. Attributes not listed here are stripped. */
export const ALLOWED_TAGS: Record<string, string[]> = {
  p: [],
  br: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  strong: [],
  em: [],
  del: [],
  blockquote: [],
  code: [],
  pre: [],
  ul: [],
  ol: [],
  li: [],
  // href is kept, rel is force-injected by injectRel in markdown.ts.
  a: ['href', 'rel'],
  hr: [],
  // GFM tables: no attributes allowed (marked emits align as style= which we strip).
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: [],
  td: [],
};

/** Tags with no closing tag and no children. */
export const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr']);

/** Tags that render as their own block. Decides which diff marker class applies. */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'tr',
]);

/**
 * Containers whose direct text children are layout, not content. renderMarkdown puts
 * newlines between the items of a list, the rows of a table and inside a blockquote,
 * so a two-item list is five child nodes. Diffing those newlines as content lets the
 * matcher anchor on them instead of on the items.
 */
export const STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  'ul', 'ol', 'table', 'thead', 'tbody', 'tr', 'blockquote',
]);

/** The complete set of classes the diff renderer may emit. Nothing else is allowed. */
export const DIFF_CLASSES: ReadonlySet<string> = new Set([
  'diff-add', 'diff-del', 'diff-meta', 'diff-block-add', 'diff-block-del',
]);
