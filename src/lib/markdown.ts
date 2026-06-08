/**
 * Server-side markdown rendering with strict XSS sanitization.
 *
 * Pipeline:
 *   1. marked.parse: converts Markdown to HTML (passes raw HTML through unchanged).
 *   2. xss FilterXSS: strips everything not on the strict allowlist; neutralizes
 *      dangerous protocols via onTagAttr (a href) and safeAttrValue (other attrs).
 *   3. injectRel: ensures every surviving <a> has rel="noopener noreferrer nofollow ugc".
 *
 * Link href policy: ONLY http:// and https:// are accepted. data:, javascript:,
 * vbscript:, protocol-relative (//), bare relative paths, and all other schemes
 * are neutralized to an empty href. This prevents the safeAttrValue data:image/
 * bypass that would allow clickable data: URIs on <a> elements.
 *
 * This module runs at write time on the server, so the sanitized HTML is the only
 * form ever stored or served.
 */

import { parse as markedParse } from 'marked';
import { FilterXSS } from 'xss';

// Strict allowlist: structural/text tags only, no presentational attributes.
// Attributes not listed are stripped automatically by the sanitizer.
// GFM table tags (table, thead, tbody, tr, th, td) are included so that
// tables in CIP-108 rationale markdown render correctly.
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
  // GFM tables: no attributes allowed (marked emits align as style= which we strip).
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: [],
  td: [],
};

const sanitizer = new FilterXSS({
  whiteList: ALLOWED_TAGS,
  // Strip disallowed tags entirely (not escaped, stripped).
  stripIgnoreTag: true,
  // Also strip the text content inside these dangerous tags so their
  // inline JS/CSS text does not leak as visible text nodes.
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'svg', 'object', 'embed'],
  onTagAttr(tag: string, name: string, value: string, _isWhiteAttr: boolean): string | undefined {
    if (tag === 'a' && name === 'rel') {
      // Override whatever rel value the original HTML had: our value is canonical.
      return 'rel="noopener noreferrer nofollow ugc"';
    }

    if (tag === 'a' && name === 'href') {
      // Strict scheme allowlist: strip ASCII control chars and whitespace first
      // (these are used to obfuscate schemes like "java\tscript:"), then check
      // that the normalized value starts with http:// or https:// only.
      // Everything else (data:, javascript:, vbscript:, //, relative paths, ...) is
      // neutralized to an empty href. This closes the data:image/ bypass where
      // safeAttrValue would have passed data:image/svg+xml links through unchanged.
      const normalized = value.replace(/[\x00-\x20\x7F]+/g, '').toLowerCase();
      if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
        return `href="${value}"`;
      }
      // Neutralize: emit an inert empty href so the <a> element is preserved for
      // its text content but carries no navigable destination.
      return 'href=""';
    }

    // All other attributes: use default handling (safeAttrValue is applied
    // automatically, which neutralizes javascript:, data:, vbscript: in those attrs).
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
