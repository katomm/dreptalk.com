/**
 * Server-side markdown rendering with strict XSS sanitization.
 *
 * Pipeline:
 *   1. marked.parse: converts Markdown to HTML (passes raw HTML through unchanged).
 *   2. xss FilterXSS: strips everything not on the strict allowlist; neutralizes
 *      dangerous protocols via onTagAttr (a href) and safeAttrValue (other attrs).
 *   3. injectRel: ensures every surviving <a> has rel="noopener noreferrer nofollow ugc".
 *
 * Opening links in a new tab is a display concern handled by ensureLinkTarget at
 * render time (it also covers content stored before that behavior existed), not
 * baked into the stored HTML here.
 *
 * Link href policy: http://, https://, and internal paths (a single leading
 * slash, not protocol-relative) are accepted. data:, javascript:, vbscript:,
 * protocol-relative (//), and all other schemes are neutralized to an empty
 * href. This prevents the safeAttrValue data:image/ bypass that would allow
 * clickable data: URIs on <a> elements.
 *
 * This module runs at write time on the server, so the sanitized HTML is the only
 * form ever stored or served.
 */

import { Marked } from 'marked';
// xss is CommonJS and does `exports = module.exports = filterXSS` before attaching
// its named exports, so the CJS-to-ESM lexer in the Workers test pool's esbuild does
// not hoist them and a named `{ FilterXSS }` import resolves to undefined. The default
// export is the module.exports object with FilterXSS attached, so reach it through that.
import xssModule from 'xss';

const { FilterXSS } = xssModule as unknown as typeof import('xss');

/** Rendering info for one resolved mention slug. */
export interface MentionLink {
  /** Internal profile path, e.g. /dreps/alice-drep/. */
  href: string;
  /** Display name shown as the link text (rendered as @label). */
  label: string;
}

// Minimal HTML entity escape for text interpolated into renderer output. The
// mention label is an on-chain display name, i.e. untrusted: without this a
// name containing markup could break out of the <a> element (the sanitizer
// strips dangerous tags afterwards, but broken nesting would remain).
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// @slug mentions. Syntax contract shared with extractMentionSlugs
// (src/lib/forum/mentions.ts): '@' preceded by start / whitespace / '(' / '>',
// slug = [a-z0-9][a-z0-9-]{1,63}. Only slugs present in the per-call map are
// linkified (shown as @display-name, linked to the profile); everything else
// falls through as plain text. Runs as a marked inline extension, so code
// spans and fences are never touched. The extension closes over the caller's
// map, so each renderMarkdown call builds its own Marked instance: no shared
// mutable state between calls.
function mentionExtension(mentions: ReadonlyMap<string, MentionLink>) {
  return {
    name: 'mention',
    level: 'inline' as const,
    start(src: string): number | undefined {
      const m = /(^|[\s(>])@[a-z0-9]/.exec(src);
      return m ? m.index + m[1].length : undefined;
    },
    tokenizer(
      src: string,
      // biome-ignore lint/suspicious/noExplicitAny: marked's accumulated inline token union is unwieldy for a structural check
      tokens: any[],
    ): { type: 'mention'; raw: string; slug: string } | undefined {
      const m = /^@([a-z0-9][a-z0-9-]{1,63})/.exec(src);
      if (!m || !mentions.has(m[1])) return undefined;
      // GFM's inline text tokenizer halts before '@' to attempt an email
      // autolink, so this tokenizer can be invoked at mid-word positions too
      // (e.g. 'foo@alice-drep'), not only at a genuine segment boundary. Restore
      // the segment-boundary contract shared with extractMentionSlugs
      // (src/lib/forum/mentions.ts): reject only when the previous token is
      // plain text whose last character is not whitespace / '(' / '>'. No
      // previous token means start of input (accept); a previous inline
      // element (strong, em, codespan, link, del, escape, html, ...) means
      // marked already split a new text token here, which is a segment
      // boundary by construction (accept), matching '**foo**@a1' staying a
      // mention.
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text' && !/[\s(>]$/.test(prev.raw)) return undefined;
      return { type: 'mention', raw: m[0], slug: m[1] };
    },
    renderer(token: { slug: string }): string {
      // Sanitizer-safe output: <a href> with an internal path (allowed below).
      // The link text shows the display name, escaped: on-chain names are
      // untrusted input. The slug stays only in the href (and the source md).
      const link = mentions.get(token.slug);
      if (!link) return `@${token.slug}`;
      return `<a href="${link.href}">@${escapeHtml(link.label)}</a>`;
    },
  };
}

// Shared instance for the common no-mentions path; mention-aware calls build
// their own instance in renderMarkdown with the extension closed over the map.
const plainMarked = new Marked();

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
      // that the normalized value starts with http://, https://, or a single
      // leading slash (internal path, not protocol-relative).
      // Everything else (data:, javascript:, vbscript:, //, ...) is neutralized
      // to an empty href. This closes the data:image/ bypass where safeAttrValue
      // would have passed data:image/svg+xml links through unchanged.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional, strips ASCII control chars used to obfuscate schemes (e.g. "java\tscript:")
      const normalized = value.replace(/[\x00-\x20\x7F]+/g, '').toLowerCase();
      // WHATWG URL parsing treats '\' the same as '/' for http(s) pages, so any
      // two leading slash-or-backslash characters (in any combination, e.g.
      // "/\", "\/", "\\") make a browser parse the rest as a host, not a path.
      // A single leading '/' followed by anything else stays a same-origin path.
      const secondChar = normalized[1];
      const isInternalPath = normalized.startsWith('/') && secondChar !== '/' && secondChar !== '\\';
      if (normalized.startsWith('http://') || normalized.startsWith('https://') || isInternalPath) {
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
 * Add target="_blank" to every <a> that lacks it, so links in rendered user
 * content open in a new tab. A cheap, idempotent regex pass applied at DISPLAY
 * time over already-sanitized stored HTML: it covers posts and rationales saved
 * before this behavior existed, without re-rendering or a data backfill. Links
 * keep their existing rel (set by injectRel at write time).
 */
export function ensureLinkTarget(html: string): string {
  return html.replace(/<a(\s[^>]*)?>/gi, (match: string, attrs: string | undefined): string => {
    const attrStr = attrs ?? '';
    if (/\btarget\s*=/i.test(attrStr)) return match;
    return `<a${attrStr} target="_blank">`;
  });
}

/**
 * Render a Markdown string to sanitized HTML safe for storage and display.
 *
 * @param md - Raw Markdown input from an untrusted user.
 * @param opts.mentions - Slug to { href, label } map. When given, @slug
 *   mentions matching a key render as internal profile links showing
 *   @display-name; otherwise @slug stays plain text.
 * @returns Sanitized HTML string. Never contains executable content.
 */
export function renderMarkdown(md: string, opts?: { mentions?: ReadonlyMap<string, MentionLink> }): string {
  const mentions = opts?.mentions;
  const marked = mentions?.size
    ? new Marked({ extensions: [mentionExtension(mentions)] })
    : plainMarked;

  // Step 1: parse Markdown to HTML.
  const raw = marked.parse(md, { async: false, gfm: true, breaks: true }) as string;

  // Step 2: sanitize with strict allowlist.
  const sanitized = sanitizer.process(raw);

  // Step 3: force rel on all surviving links.
  return injectRel(sanitized);
}
