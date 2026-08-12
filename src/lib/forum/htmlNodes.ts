// A parser for the narrow HTML grammar the post sanitizer emits, and nothing else.
//
// Input contract: only strings produced by renderMarkdown (src/lib/markdown.ts),
// which strips every tag and attribute outside the shared grammar. Anything
// unexpected is a sanitizer bug, not hostile input to recover from, so this parser
// throws instead of guessing. Keeping it strict is what lets the diff claim it never
// widens the allowlist.
//
// The tokenizer below only matches well-formed markup: double-quoted attribute
// values, tag names in the grammar's alphabet. Anything else at a given position,
// an unquoted attribute, a hyphenated custom element, any malformed angle-bracket
// sequence, simply fails to match there, and the regex resumes further along,
// leaving the unmatched span to be swept up as plain text. That text can never
// legitimately contain a raw '<': renderMarkdown escapes it to &lt;, which the
// round-trip fixture 'a & b < c > d' exercises. So a raw '<' inside a text run is
// proof the tokenizer skipped markup it could not parse, and pushText throws on it
// rather than letting it round-trip untouched into serialized output.
//
// Structural whitespace: renderMarkdown puts newlines between list items, table rows
// and blocks, so a two-item list arrives as five child nodes. Those text nodes are
// layout, not content, and are flagged ignorable so the diff can skip them without
// touching whitespace inside a paragraph or a code block, where it is content.

import { ALLOWED_TAGS, STRUCTURAL_TAGS, VOID_TAGS } from '../sanitizedHtmlGrammar.js';

export type HtmlNode =
  | { kind: 'text'; text: string; ignorable: boolean }
  | { kind: 'element'; tag: string; attrs: Record<string, string>; children: HtmlNode[] }
  | { kind: 'void'; tag: string };

const TOKEN = /<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[a-z-]+="[^"]*")*)\s*\/?>/gi;
const ATTR = /([a-z-]+)="([^"]*)"/gi;

function parseAttrs(tag: string, raw: string): Record<string, string> {
  const allowed = ALLOWED_TAGS[tag] ?? [];
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m = ATTR.exec(raw);
  while (m) {
    if (!allowed.includes(m[1])) {
      throw new Error(`unsupported attribute ${m[1]} on <${tag}>`);
    }
    attrs[m[1]] = m[2];
    m = ATTR.exec(raw);
  }
  return attrs;
}

/** Parses sanitized HTML into a node tree. Throws on anything outside the grammar. */
export function parseSanitizedHtml(html: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  const stack: { tag: string; children: HtmlNode[] }[] = [];
  const top = (): HtmlNode[] => (stack.length ? stack[stack.length - 1].children : root);
  // Whitespace directly inside a structural container, or between top-level blocks,
  // is layout. Everywhere else (a paragraph, inline markup, pre) it is content.
  const inStructuralContext = (): boolean =>
    stack.length === 0 || STRUCTURAL_TAGS.has(stack[stack.length - 1].tag);

  const pushText = (text: string): void => {
    if (text.includes('<')) throw new Error(`unparsed markup near ${JSON.stringify(text)}`);
    top().push({
      kind: 'text',
      text,
      ignorable: inStructuralContext() && text.trim() === '',
    });
  };

  let cursor = 0;
  TOKEN.lastIndex = 0;
  let m = TOKEN.exec(html);
  while (m) {
    if (m.index > cursor) pushText(html.slice(cursor, m.index));
    cursor = m.index + m[0].length;

    const closing = m[1]?.toLowerCase();
    const opening = m[2]?.toLowerCase();

    if (closing) {
      const open = stack.pop();
      if (!open || open.tag !== closing) throw new Error(`mismatched closing tag </${closing}>`);
    } else if (opening) {
      if (!Object.hasOwn(ALLOWED_TAGS, opening)) throw new Error(`unsupported tag <${opening}>`);
      if (VOID_TAGS.has(opening)) {
        top().push({ kind: 'void', tag: opening });
      } else {
        const node: HtmlNode = {
          kind: 'element',
          tag: opening,
          attrs: parseAttrs(opening, m[3] ?? ''),
          children: [],
        };
        top().push(node);
        stack.push({ tag: opening, children: node.children });
      }
    }
    m = TOKEN.exec(html);
  }
  if (cursor < html.length) pushText(html.slice(cursor));
  if (stack.length) throw new Error(`mismatched unclosed tag <${stack[stack.length - 1].tag}>`);
  return root;
}

/** Writes a node tree back out. Text is already entity-encoded by the sanitizer. */
export function serializeNodes(nodes: HtmlNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text') return node.text;
      if (node.kind === 'void') return `<${node.tag}>`;
      const attrs = Object.entries(node.attrs)
        .map(([k, v]) => ` ${k}="${v}"`)
        .join('');
      return `<${node.tag}${attrs}>${serializeNodes(node.children)}</${node.tag}>`;
    })
    .join('');
}

/** Concatenated text content of a node, used for pairing and stats. */
export function nodeText(node: HtmlNode): string {
  if (node.kind === 'text') return node.text;
  if (node.kind === 'void') return node.tag === 'br' ? '\n' : '';
  return node.children.map(nodeText).join('');
}
