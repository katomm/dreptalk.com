import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdown.js';
import { parseSanitizedHtml, serializeNodes, nodeText } from './htmlNodes.js';

const md = (s: string): string => renderMarkdown(s, { mentions: new Map() });

describe('parseSanitizedHtml', () => {
  it('parses a paragraph into one element with one text child', () => {
    expect(parseSanitizedHtml('<p>hello</p>')).toEqual([
      {
        kind: 'element',
        tag: 'p',
        attrs: {},
        children: [{ kind: 'text', text: 'hello', ignorable: false }],
      },
    ]);
  });

  it('flags whitespace between blocks as ignorable', () => {
    const nodes = parseSanitizedHtml('<p>a</p>\n<p>b</p>\n');
    const texts = nodes.filter((n) => n.kind === 'text');
    expect(texts).toHaveLength(2);
    for (const t of texts) expect(t).toMatchObject({ ignorable: true });
  });

  it('flags whitespace inside a list as ignorable', () => {
    const [ul] = parseSanitizedHtml('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    const ws = (ul as { children: { kind: string; ignorable?: boolean }[] }).children.filter(
      (c) => c.kind === 'text',
    );
    expect(ws).toHaveLength(3);
    for (const t of ws) expect(t.ignorable).toBe(true);
  });

  it('does not flag whitespace inside a paragraph', () => {
    const [p] = parseSanitizedHtml('<p>a <strong>b</strong></p>');
    const text = (p as { children: { ignorable?: boolean }[] }).children[0];
    expect(text.ignorable).toBe(false);
  });

  it('does not flag whitespace inside pre', () => {
    const nodes = parseSanitizedHtml('<pre><code>  \n</code></pre>');
    expect(nodeText(nodes[0])).toBe('  \n');
    const code = (nodes[0] as { children: { children: { ignorable?: boolean }[] }[] }).children[0];
    expect(code.children[0].ignorable).toBe(false);
  });

  it('keeps link attributes', () => {
    const nodes = parseSanitizedHtml('<p><a href="/foo" rel="noopener">x</a></p>');
    const link = (nodes[0] as { children: { attrs: Record<string, string> }[] }).children[0];
    expect(link.attrs).toEqual({ href: '/foo', rel: 'noopener' });
  });

  it('parses void tags', () => {
    expect(parseSanitizedHtml('<p>a<br>b</p>')).toEqual([
      {
        kind: 'element',
        tag: 'p',
        attrs: {},
        children: [
          { kind: 'text', text: 'a', ignorable: false },
          { kind: 'void', tag: 'br' },
          { kind: 'text', text: 'b', ignorable: false },
        ],
      },
    ]);
  });

  it('throws on a tag outside the grammar', () => {
    expect(() => parseSanitizedHtml('<span>x</span>')).toThrow(/unsupported tag/);
  });

  it('throws on an attribute outside the grammar', () => {
    expect(() => parseSanitizedHtml('<p class="x">a</p>')).toThrow(/unsupported attribute/);
    expect(() => parseSanitizedHtml('<a onclick="x">a</a>')).toThrow(/unsupported attribute/);
    expect(() => parseSanitizedHtml('<a href="/x" target="_blank">a</a>')).toThrow(
      /unsupported attribute/,
    );
  });

  it('throws on mismatched nesting', () => {
    expect(() => parseSanitizedHtml('<p><em>x</p></em>')).toThrow(/mismatched/);
    expect(() => parseSanitizedHtml('<p>x')).toThrow(/mismatched/);
  });

  it('throws on unparsed markup instead of passing it through as text', () => {
    // Unquoted attribute value: the tokenizer only matches double-quoted values,
    // so this fails to match as a tag and would otherwise fall into a text node.
    expect(() => parseSanitizedHtml('<a href=/x>t</a>')).toThrow(/unparsed markup/);
    // Tag name shape (hyphenated custom element) that also fails the tokenizer's
    // tag-name alphabet, not just the allowlist.
    expect(() => parseSanitizedHtml('<my-widget>x</my-widget>')).toThrow(/unparsed markup/);
    // The concrete attack this guards against: an unquoted-attribute payload that
    // would otherwise round-trip byte for byte into serialized output.
    expect(() => parseSanitizedHtml('<img src=x onerror=alert(1)>')).toThrow(/unparsed markup/);
  });
});

describe('round-trip over real renderMarkdown output', () => {
  // The parser exists for this renderer's output, so the fixtures are its output,
  // not hand-written compact HTML.
  const sources = [
    'one\n\ntwo',
    '- a\n- b',
    '1. a\n2. b',
    '> quoted\n\nafter',
    '| h |\n| --- |\n| c |',
    'para with **bold**, *em*, ~~struck~~ and [link](/x)',
    '```\ncode\n```',
    '## heading\n\nbody',
    'line one  \nline two',
    '---\n\nafter the rule',
    'a & b < c > d',
  ];

  it('serializes back to exactly what the renderer produced', () => {
    for (const src of sources) {
      const html = md(src);
      expect(serializeNodes(parseSanitizedHtml(html))).toBe(html);
    }
  });

  it('accepts everything the renderer can produce', () => {
    for (const src of sources) {
      expect(() => parseSanitizedHtml(md(src))).not.toThrow();
    }
  });
});
