/**
 * Workers-runtime tests for renderMarkdown.
 *
 * Negative cases assert that no dangerous artifact survives sanitization.
 * Positive cases assert that safe Markdown is rendered correctly.
 *
 * Running in the workerd pool proves that both `marked` and `xss` load and
 * execute inside the Cloudflare Workers runtime.
 */

import { describe, it, expect } from 'vitest';
import { enhanceStoredHtml, ensureLinkTarget, linkifyGovActionIds, renderMarkdown } from './markdown';

// Helpers for negative assertions.
function assertInert(html: string, label: string): void {
  expect(html, `${label}: no <script`).not.toMatch(/<script/i);
  expect(html, `${label}: no onerror`).not.toMatch(/onerror\s*=/i);
  expect(html, `${label}: no onload`).not.toMatch(/onload\s*=/i);
  expect(html, `${label}: no onclick`).not.toMatch(/onclick\s*=/i);
  expect(html, `${label}: no on* events`).not.toMatch(/\bon\w+\s*=/i);
  expect(html, `${label}: no javascript:`).not.toMatch(/javascript:/i);
  expect(html, `${label}: no data: in href`).not.toMatch(/href\s*=\s*["']?\s*data:/i);
  expect(html, `${label}: no vbscript:`).not.toMatch(/vbscript:/i);
  expect(html, `${label}: no <iframe`).not.toMatch(/<iframe/i);
  expect(html, `${label}: no <img`).not.toMatch(/<img/i);
  expect(html, `${label}: no <style`).not.toMatch(/<style/i);
  expect(html, `${label}: no <svg`).not.toMatch(/<svg/i);
  expect(html, `${label}: no <object`).not.toMatch(/<object/i);
  expect(html, `${label}: no <embed`).not.toMatch(/<embed/i);
}

describe('renderMarkdown - security (negative cases)', () => {
  it('strips raw <script> tags and their body text', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    assertInert(out, 'script tag');
    // Body text must also not appear (stripIgnoreTagBody removes it).
    expect(out).not.toContain('alert(1)');
  });

  it('strips markdown link with javascript: protocol', () => {
    const out = renderMarkdown('[x](javascript:alert(1))');
    assertInert(out, 'js: link md');
  });

  it('strips markdown link with JavaScript: (uppercase variant)', () => {
    const out = renderMarkdown('[x](JavaScript:alert(1))');
    assertInert(out, 'JS: uppercase link');
  });

  it('strips markdown link with java\\tscript: (tab-obfuscated)', () => {
    // Some renderers normalize whitespace; xss safeAttrValue strips it too.
    const out = renderMarkdown('[x](java\tscript:alert(1))');
    assertInert(out, 'java-tab-script link');
  });

  it('strips <img> with onerror handler', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>');
    assertInert(out, 'img onerror');
  });

  it('strips markdown link with data: protocol', () => {
    const out = renderMarkdown('[x](data:text/html,<script>alert(1)</script>)');
    assertInert(out, 'data: link md');
  });

  it('strips raw <a href="data:..."> tag', () => {
    const out = renderMarkdown('<a href="data:text/html,<script>alert(1)</script>">click</a>');
    assertInert(out, 'raw data: link');
  });

  it('strips raw <iframe>', () => {
    const out = renderMarkdown('<iframe src="https://evil.example.com"></iframe>');
    assertInert(out, 'iframe');
    expect(out).not.toContain('<iframe');
  });

  it('strips raw <style> and its content', () => {
    const out = renderMarkdown('<style>body { background: red; }</style>');
    assertInert(out, 'style tag');
    expect(out).not.toContain('body {');
  });

  it('strips <svg onload=...> and body content', () => {
    const out = renderMarkdown('<svg onload=alert(1)><script>alert(2)</script></svg>');
    assertInert(out, 'svg onload');
  });

  it('strips <object data=...>', () => {
    const out = renderMarkdown('<object data="https://evil.example.com/flash.swf"></object>');
    assertInert(out, 'object');
  });

  it('strips <embed>', () => {
    const out = renderMarkdown('<embed src="https://evil.example.com/x.swf">');
    assertInert(out, 'embed');
  });

  it('strips <a href="vbscript:..."> ', () => {
    const out = renderMarkdown('<a href="vbscript:msgbox(1)">x</a>');
    assertInert(out, 'vbscript link');
  });

  it('strips onclick attribute from <div>', () => {
    const out = renderMarkdown('<div onclick="alert(1)">x</div>');
    assertInert(out, 'div onclick');
    // div is not whitelisted, so it gets stripped; text survives
    expect(out).toContain('x');
  });

  it('handles link text/url trying to smuggle script tags', () => {
    const out = renderMarkdown('["><script>alert(1)</script>](https://safe.example.com)');
    assertInert(out, 'smuggled script in link text');
  });

  // data:image/ bypass: safeAttrValue used to pass data:image/* through for img src,
  // but the same logic also applied to <a href>, creating a stored-XSS vector.
  it('neutralizes data:image/svg+xml link href (XSS bypass)', () => {
    const svg64 =
      'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=';
    const out = renderMarkdown(`[x](data:image/svg+xml;base64,${svg64})`);
    // The dangerous data: URI must not survive as a navigable href.
    expect(out, 'no data:image/svg in href').not.toMatch(/href\s*=\s*["']?\s*data:image\/svg/i);
    expect(out, 'no raw data:image/svg').not.toContain('data:image/svg');
    // The link text may still appear (element preserved but href neutralized).
    assertInert(out, 'data:image/svg+xml link');
  });

  it('neutralizes data:image/png link href', () => {
    const out = renderMarkdown('[x](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)');
    expect(out, 'no data:image/png in href').not.toMatch(/href\s*=\s*["']?\s*data:image\/png/i);
    expect(out, 'no raw data:image/png').not.toContain('data:image/png');
    assertInert(out, 'data:image/png link');
  });

  it('neutralizes protocol-relative // link href', () => {
    const out = renderMarkdown('[x](//evil.example.com)');
    expect(out, 'no protocol-relative href').not.toMatch(/href\s*=\s*["']?\/\//i);
    assertInert(out, 'protocol-relative link');
  });

  it('allows a single-leading-slash internal relative path link href', () => {
    const out = renderMarkdown('[x](/relative/path)');
    // Single-leading-slash paths are internal navigation and are now allowed;
    // protocol-relative (//) paths are still blocked, see below.
    expect(out).toContain('href="/relative/path"');
    assertInert(out, 'relative path link');
  });
});

describe('renderMarkdown - href scheme normalization (control chars)', () => {
  it('accepts https link with leading spaces before the URL', () => {
    const out = renderMarkdown('[x](  https://example.com)');
    expect(out).toContain('href="https://example.com"');
  });

  it('accepts https link with leading tab before the URL', () => {
    const out = renderMarkdown('[x](\thttps://example.com)');
    expect(out).toContain('href="https://example.com"');
  });
});

describe('renderMarkdown - correctness (positive cases)', () => {
  it('renders bold with **', () => {
    const out = renderMarkdown('**bold**');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('renders italic with *', () => {
    const out = renderMarkdown('*italic*');
    expect(out).toContain('<em>italic</em>');
  });

  it('renders strikethrough with ~~', () => {
    const out = renderMarkdown('~~strike~~');
    expect(out).toContain('<del>strike</del>');
  });

  it('renders inline code', () => {
    const out = renderMarkdown('`code`');
    expect(out).toContain('<code>code</code>');
  });

  it('renders fenced code block', () => {
    const out = renderMarkdown('```\nconst x = 1;\n```');
    expect(out).toContain('<pre>');
    expect(out).toContain('<code>');
    expect(out).toContain('const x = 1;');
  });

  it('renders h1', () => {
    const out = renderMarkdown('# Heading One');
    expect(out).toContain('<h1>');
    expect(out).toContain('Heading One');
  });

  it('renders h2', () => {
    const out = renderMarkdown('## Heading Two');
    expect(out).toContain('<h2>');
    expect(out).toContain('Heading Two');
  });

  it('renders blockquote', () => {
    const out = renderMarkdown('> quoted text');
    expect(out).toContain('<blockquote>');
    expect(out).toContain('quoted text');
  });

  it('renders unordered list', () => {
    const out = renderMarkdown('- alpha\n- beta');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('renders ordered list', () => {
    const out = renderMarkdown('1. first\n2. second');
    expect(out).toContain('<ol>');
    expect(out).toContain('<li>');
    expect(out).toContain('first');
    expect(out).toContain('second');
  });

  it('renders safe https link with href', () => {
    const out = renderMarkdown('[visit](https://example.com)');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('visit');
  });

  it('renders safe http link with href', () => {
    const out = renderMarkdown('[visit](http://example.com)');
    expect(out).toContain('href="http://example.com"');
    expect(out).toContain('visit');
  });

  it('forces rel="noopener noreferrer nofollow ugc" on safe https links', () => {
    const out = renderMarkdown('[text](https://example.com)');
    expect(out).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  it('forces rel="noopener noreferrer nofollow ugc" on safe http links', () => {
    const out = renderMarkdown('[text](http://example.com)');
    expect(out).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  it('does NOT bake target= into stored HTML (new tab is a display concern)', () => {
    const out = renderMarkdown('[text](https://example.com)');
    expect(out).not.toMatch(/\btarget\s*=/i);
  });

  it('overrides any existing rel on raw <a> tags', () => {
    const out = renderMarkdown('<a href="https://safe.example.com" rel="evil-value">link</a>');
    expect(out).toContain('rel="noopener noreferrer nofollow ugc"');
    expect(out).not.toContain('evil-value');
  });

  it('preserves plain text without modification', () => {
    const out = renderMarkdown('Hello world');
    expect(out).toContain('Hello world');
  });

  it('renders GFM table with table/tr/td/th elements surviving sanitization', () => {
    const md = '| Col A | Col B |\n| ----- | ----- |\n| val 1 | val 2 |';
    const out = renderMarkdown(md);
    expect(out).toContain('<table>');
    expect(out).toContain('<tr>');
    expect(out).toContain('<td>');
    expect(out).toContain('val 1');
    expect(out).toContain('val 2');
  });

  it('keeps script tags stripped even when table markdown is present', () => {
    const md = '| A |\n| - |\n| <script>alert(1)</script> |';
    const out = renderMarkdown(md);
    expect(out).toContain('<table>');
    assertInert(out, 'table with embedded script');
    expect(out).not.toContain('alert(1)');
  });
});

describe('ensureLinkTarget', () => {
  it('adds target="_blank" to a link that lacks it', () => {
    const out = ensureLinkTarget('<a href="https://example.com" rel="noopener">x</a>');
    expect(out).toBe('<a href="https://example.com" rel="noopener" target="_blank">x</a>');
  });

  it('is idempotent and leaves an existing target untouched', () => {
    const html = '<a href="https://example.com" target="_blank">x</a>';
    expect(ensureLinkTarget(html)).toBe(html);
  });

  it('preserves rel and text on stored markdown output', () => {
    const out = ensureLinkTarget(renderMarkdown('[text](https://example.com)'));
    expect(out).toContain('rel="noopener noreferrer nofollow ugc"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('text');
  });

  it('does not touch content without links', () => {
    expect(ensureLinkTarget('<p>Hello world</p>')).toBe('<p>Hello world</p>');
  });
});

describe('mentions', () => {
  const hrefs = new Map([['alice-drep', { href: '/dreps/alice-drep/', label: 'Alice' }]]);

  it('renders a resolved mention as an internal profile link with the display name', () => {
    const html = renderMarkdown('hi @alice-drep!', { mentions: hrefs });
    expect(html).toContain('<a href="/dreps/alice-drep/"');
    expect(html).toContain('>@Alice</a>');
    expect(html).not.toContain('@alice-drep</a>');
  });

  it('HTML-escapes the display name (on-chain names are untrusted)', () => {
    const evil = new Map([['alice-drep', { href: '/dreps/alice-drep/', label: 'A<b>&"x"</b>' }]]);
    const html = renderMarkdown('hi @alice-drep', { mentions: evil });
    expect(html).toContain('>@A&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;</a>');
    expect(html).not.toContain('<b>');
  });

  it('leaves unresolved mentions, emails and code untouched', () => {
    expect(renderMarkdown('hi @nobody', { mentions: hrefs })).not.toContain('<a');
    // 'foo@alice-drep.com' is not a mention (the '@' is not at a segment start,
    // per the shared syntax contract), so it never resolves to a profile link.
    // GFM's own bare-email autolinking is a separate, pre-existing marked
    // feature: it still wraps this in an <a>, but the mailto: href is
    // neutralized to "" by the unrelated scheme allowlist below, so the point
    // under test here (no mention link) holds regardless.
    expect(renderMarkdown('foo@alice-drep.com', { mentions: hrefs })).not.toContain('href="/dreps/alice-drep/"');
    expect(renderMarkdown('`@alice-drep`', { mentions: hrefs })).not.toContain('<a');
  });

  it('does not linkify mentions without the opt-in map', () => {
    expect(renderMarkdown('hi @alice-drep')).not.toContain('<a');
  });

  it('linkifies a mention right after a bold span, matching extractMentionSlugs segment boundary', () => {
    // Consistency with extractMentionSlugs (src/lib/forum/mentions.ts): marked
    // splits inline content into a new text token after **foo**, so '@alice-drep'
    // starts its own segment there and matches the same as at document start.
    const html = renderMarkdown('**foo**@alice-drep', { mentions: hrefs });
    expect(html).toContain('<a href="/dreps/alice-drep/"');
    expect(html).toContain('>@Alice</a>');
  });

  it('does not linkify a mid-word "@" (GFM email autolink boundary bypass)', () => {
    // GFM's inline text tokenizer halts before '@' to attempt an email
    // autolink, so marked can invoke the mention tokenizer at a mid-word
    // position even though extractMentionSlugs never matches there (the '@'
    // is not preceded by start / whitespace / '(' / '>').
    expect(renderMarkdown('foo@alice-drep', { mentions: hrefs })).not.toContain('<a');
  });

  it('does not linkify a mention preceded by punctuation other than "(" or ">"', () => {
    expect(renderMarkdown('.@alice-drep', { mentions: hrefs })).not.toContain('<a');
  });
});

describe('linkifyGovActionIds', () => {
  const ID = 'gov_action1fdatlfcdnzzcw5x9pnt9r42v992nqw65zze57s8tyk0jll78eyusqccn9gc';

  it('turns a bare gov action id into a linked, copyable chip', () => {
    const out = linkifyGovActionIds(`<td>${ID}</td>`);
    expect(out).toContain('class="chainid"');
    expect(out).toContain(`href="/ga/${ID}/"`);
    // Middle-truncated display text, full value only in href/title/data-copy.
    expect(out).toContain('>gov_action1fda...ccn9gc</a>');
    // The copy button carries the FULL id so it stays fully copyable.
    expect(out).toContain(`data-copy="${ID}"`);
  });

  it('leaves an id inside a link href untouched (no corruption, no chip)', () => {
    const out = linkifyGovActionIds(`<a href="https://gov.tools/x/${ID}">see</a>`);
    expect(out).toBe(`<a href="https://gov.tools/x/${ID}">see</a>`);
    expect(out).not.toContain('class="chainid"');
  });

  it('leaves an id that is a link text untouched (never nests a link)', () => {
    const out = linkifyGovActionIds(`<a href="/t/x/">${ID}</a>`);
    expect(out).not.toContain('class="chainid"');
  });

  it('leaves ids inside <code> and <pre> untouched', () => {
    expect(linkifyGovActionIds(`<code>${ID}</code>`)).not.toContain('class="chainid"');
    expect(linkifyGovActionIds(`<pre>${ID}</pre>`)).not.toContain('class="chainid"');
  });

  it('does not treat <article> as an <a> boundary', () => {
    const out = linkifyGovActionIds(`<article>${ID}</article>`);
    expect(out).toContain('class="chainid"');
  });

  it('chips every id in a paragraph with multiple ids', () => {
    const out = linkifyGovActionIds(`<p>${ID} and ${ID}</p>`);
    expect(out.match(/class="chainid"/g)).toHaveLength(2);
  });

  it('leaves content without an id unchanged', () => {
    expect(linkifyGovActionIds('<p>no ids here</p>')).toBe('<p>no ids here</p>');
  });
});

describe('enhanceStoredHtml', () => {
  const ID = 'gov_action1fdatlfcdnzzcw5x9pnt9r42v992nqw65zze57s8tyk0jll78eyusqccn9gc';

  it('chips gov action ids and opens links in a new tab', () => {
    const out = enhanceStoredHtml(`<td>${ID}</td>`);
    expect(out).toContain('class="chainid"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain(`data-copy="${ID}"`);
  });

  it('still adds target to ordinary markdown links', () => {
    const out = enhanceStoredHtml(renderMarkdown('[t](https://example.com)'));
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow ugc"');
  });
});

describe('internal hrefs', () => {
  it('keeps single-slash internal links and still strips protocol-relative ones', () => {
    expect(renderMarkdown('[t](/t/some-topic/)')).toContain('href="/t/some-topic/"');
    expect(renderMarkdown('[x](//evil.example)')).toContain('href=""');
    expect(renderMarkdown('[x](javascript:alert(1))')).toContain('href=""');
  });

  it('neutralizes a leading-backslash internal path (WHATWG URL treats /\\ as protocol-relative)', () => {
    // Browsers normalize backslash to slash when resolving a URL against an
    // http(s) page, so a raw <a href="/\evil.example"> (only reachable via
    // raw HTML input, markdown link syntax percent-encodes the backslash)
    // resolves to https://evil.example/, not a same-origin path. Any two
    // leading slash-or-backslash characters must be rejected, not just "//".
    const out = renderMarkdown('<a href="/\\evil.example">x</a>');
    expect(out).toContain('href=""');
  });
});
