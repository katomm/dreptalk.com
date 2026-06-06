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
import { renderMarkdown } from './markdown';

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

  it('neutralizes bare relative path link href', () => {
    const out = renderMarkdown('[x](/relative/path)');
    // Relative paths are not navigable to safe external resources and are blocked.
    expect(out, 'no relative href').not.toMatch(/href\s*=\s*["']?\/relative/i);
    assertInert(out, 'relative path link');
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

  it('does NOT add target= to links', () => {
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
});
