/**
 * Server-side markdown rendering with strict XSS sanitization.
 *
 * Pipeline:
 *   1. marked.parse: converts Markdown to HTML (passes raw HTML through unchanged).
 *   2. xss FilterXSS: strips everything not on the strict allowlist; neutralizes
 *      dangerous protocols (javascript:, data:, vbscript:) via safeAttrValue.
 *   3. injectRel: ensures every surviving <a> has rel="noopener noreferrer nofollow ugc".
 *
 * This module runs at write time on the server, so the sanitized HTML is the only
 * form ever stored or served.
 */

import { parse as markedParse } from 'marked';
import { FilterXSS } from 'xss';

// Strict allowlist: structural/text tags only, no presentational attributes.
// Attributes not listed are stripped automatically by the sanitizer.
const ALLOWED_TAGS: Record<string, string[]> = {
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
  // href is kept; rel will be force-injected by injectRel below.
  // target, name, class, id, style, on* are all omitted and therefore stripped.
  a: ['href', 'rel'],
  hr: [],
};

const sanitizer = new FilterXSS({
  whiteList: ALLOWED_TAGS,
  // Strip disallowed tags entirely (not escaped, stripped).
  stripIgnoreTag: true,
  // Also strip the text content inside these dangerous tags so their
  // inline JS/CSS text does not leak as visible text nodes.
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'svg', 'object', 'embed'],
  onTagAttr(tag: string, name: string, _value: string, _isWhiteAttr: boolean): string | undefined {
    if (tag === 'a' && name === 'rel') {
      // Override whatever rel value the original HTML had: our value is canonical.
      return 'rel="noopener noreferrer nofollow ugc"';
    }
    // All other attributes: use default handling (safeAttrValue is applied
    // automatically, which neutralizes javascript:, data:, vbscript: in href).
    return undefined;
  },
});

/**
 * Post-process: inject rel="noopener noreferrer nofollow ugc" into any <a>
 * tag that does not already have it (i.e. links that had no rel in the source).
 * The onTagAttr hook above handles links that DID have a rel attribute.
 */
function injectRel(html: string): string {
  return html.replace(/<a(\s[^>]*)?>/gi, (match: string, attrs: string | undefined): string => {
    if (attrs && /\brel\s*=/i.test(attrs)) {
      // rel already present (set by onTagAttr).
      return match;
    }
    const attrStr = attrs ?? '';
    return `<a${attrStr} rel="noopener noreferrer nofollow ugc">`;
  });
}

/**
 * Render a Markdown string to sanitized HTML safe for storage and display.
 *
 * @param md - Raw Markdown input from an untrusted user.
 * @returns Sanitized HTML string. Never contains executable content.
 */
export function renderMarkdown(md: string): string {
  // Step 1: parse Markdown to HTML.
  const raw = markedParse(md, { async: false, gfm: true, breaks: true }) as string;

  // Step 2: sanitize with strict allowlist.
  const sanitized = sanitizer.process(raw);

  // Step 3: force rel on all surviving links.
  return injectRel(sanitized);
}
