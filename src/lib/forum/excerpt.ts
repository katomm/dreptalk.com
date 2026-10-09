// Plain-text excerpts for meta descriptions of content that starts with a
// "pointer" (a link or "Proposal as pdf: <url>" line) instead of a summary.
// Markdown is rendered with the repo renderer first, so emphasis, reference
// links and definitions are resolved by the parser and the text is then taken
// from the sanitized HTML, block by block.

import { renderMarkdown } from '../markdown.js';
import { clipExcerpt, htmlToText } from './view.js';

// What may remain of a pointer block once its links are removed: an optional
// short label ending in ":" plus separators and punctuation.
const POINTER_REMAINDER_RE = /^[\s\p{P}]*([^\s]+(\s+[^\s]+){0,3}\s*:)?[\s\p{P}]*$/u;
function blockText(html: string): string {
  return htmlToText(html.replace(INLINE_TAG_RE, ''));
}
const BLOCK_BOUNDARY_RE = /<\/?(?:p|div|li|ul|ol|h[1-6]|blockquote|pre|tr|table)\b[^>]*>/i;
// Inline tags are removed without a space so "<a>word</a>." stays "word.".
const INLINE_TAG_RE = /<\/?(?:a|em|strong|b|i|u|s|del|code|span|mark|sub|sup)\b[^>]*>/gi;
// The generated opening line of a governance action post (see composeFirstPostMd).
const GENERATED_INTRO_RE = /^on-chain governance action \([^)]*\)\.?$/i;
const BARE_URL_RE = /\bhttps?:\/\/\S+/gi;

/**
 * Whether one block only points somewhere: it holds at least one link and its
 * text outside the links is at most a short "label:" and punctuation. With
 * `literalMarkers`, bare URLs count as links and stray emphasis markers are
 * ignored (stored HTML can still carry unparsed "**Proposal as pdf:**").
 */
function isPointerBlock(blockHtml: string, literalMarkers: boolean): boolean {
  const withoutLinks = blockHtml.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' ');
  let rest = blockText(withoutLinks);
  let hasLink = withoutLinks !== blockHtml;
  if (literalMarkers) {
    const noUrls = rest.replace(BARE_URL_RE, ' ');
    hasLink = hasLink || noUrls !== rest;
    rest = noUrls.replace(/\*+|__/g, '');
  }
  return hasLink && POINTER_REMAINDER_RE.test(rest);
}

/**
 * Plain-text excerpt of sanitized HTML, skipping leading pointer blocks. The
 * result is empty when every block is a pointer.
 */
export function excerptFromBlocks(html: string, maxLen = 155, opts: { literalMarkers?: boolean } = {}): string {
  const literal = opts.literalMarkers === true;
  // Code blocks never make a useful summary; inline code stays.
  const blocks = html.replace(/<pre\b[\s\S]*?<\/pre>/gi, '<p></p>').split(BLOCK_BOUNDARY_RE).filter(blockText);
  let i = 0;
  if (literal && blocks.length && GENERATED_INTRO_RE.test(blockText(blocks[0]).replace(/\*\*|__/g, ''))) i = 1;
  while (i < blocks.length && isPointerBlock(blocks[i], literal)) i++;
  let text = blocks.slice(i).map(blockText).join(' ');
  if (literal) text = text.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
  return clipExcerpt(text, maxLen);
}

/** Plain-text excerpt of a Markdown string, leading link-only lines skipped. */
export function excerptFromMarkdown(md: string, maxLen = 155): string {
  return excerptFromBlocks(renderMarkdown(md), maxLen);
}

/** Excerpt of stored post HTML that may still hold literal Markdown markers. */
export function excerptFromHtmlWithMarkdown(html: string, maxLen = 155): string {
  return excerptFromBlocks(html, maxLen, { literalMarkers: true });
}
