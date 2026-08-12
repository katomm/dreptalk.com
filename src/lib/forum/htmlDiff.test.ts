import { describe, it, expect } from 'vitest';
import { DIFF_CLASSES } from '../sanitizedHtmlGrammar.js';
import { richDiff } from './htmlDiff.js';
import { parseSanitizedHtml } from './htmlNodes.js';

/**
 * The output grammar is the input grammar plus span[class=<diff class>] plus a diff
 * class on any allowed element. Assert that, then strip the additions and require the
 * remainder to be valid input-grammar HTML.
 */
function expectValidDiffOutput(html: string): void {
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    expect(DIFF_CLASSES.has(m[1])).toBe(true);
  }
  let bare = html;
  let previous: string;
  do {
    previous = bare;
    bare = bare.replace(/<span class="diff-[a-z-]+">([^<]*)<\/span>/g, '$1');
  } while (bare !== previous);
  bare = bare.replace(/ class="diff-[a-z-]+"/g, '');
  expect(() => parseSanitizedHtml(bare)).not.toThrow();
}

const diff = (a: string, b: string) => richDiff(a, b);

describe('richDiff', () => {
  it('produces no markers for identical versions', () => {
    const r = diff('<p>same</p>', '<p>same</p>');
    expect(r.html).toBe('<p>same</p>');
    expect(r).toMatchObject({ added: 0, removed: 0, changed: false });
  });

  it('marks a changed word inside a paragraph', () => {
    const r = diff('<p>I voted No</p>', '<p>I voted Abstain</p>');
    expect(r.html).toContain('<span class="diff-del">No</span>');
    expect(r.html).toContain('<span class="diff-add">Abstain</span>');
    expect(r).toMatchObject({ added: 1, removed: 1 });
    expectValidDiffOutput(r.html);
  });

  it('marks added inline formatting on the parent, counting no words', () => {
    const r = diff('<p>hello world</p>', '<p>hello <strong>world</strong></p>');
    expect(r.html).toBe('<p class="diff-meta">hello <strong>world</strong></p>');
    expect(r).toMatchObject({ added: 0, removed: 0, changed: true });
    expectValidDiffOutput(r.html);
  });

  it('marks a changed link target on the link, counting no words', () => {
    const r = diff('<p><a href="/foo">Cardano</a></p>', '<p><a href="/bar">Cardano</a></p>');
    expect(r.html).toContain('<a href="/bar" class="diff-meta">Cardano</a>');
    expect(r).toMatchObject({ added: 0, removed: 0, changed: true });
    expectValidDiffOutput(r.html);
  });

  it('marks an inserted paragraph on the element itself', () => {
    const r = diff('<p>one</p>', '<p>one</p>\n<p>two</p>');
    expect(r.html).toContain('<p class="diff-block-add">two</p>');
    expect(r).toMatchObject({ added: 1, removed: 0 });
    expectValidDiffOutput(r.html);
  });

  it('marks a deleted paragraph', () => {
    const r = diff('<p>one</p>\n<p>two</p>', '<p>one</p>');
    expect(r.html).toContain('<p class="diff-block-del">two</p>');
    expect(r).toMatchObject({ added: 0, removed: 1 });
  });

  it('pairs list items by similarity rather than by position', () => {
    const r = diff(
      '<ul>\n<li>Alpha</li>\n<li>Beta</li>\n</ul>',
      '<ul>\n<li>Alpha</li>\n<li>New</li>\n<li>Beta changed</li>\n</ul>',
    );
    expect(r.html).toContain('<li class="diff-block-add">New</li>');
    expect(r.html).toContain('<span class="diff-add">changed</span>');
    expect(r.html).not.toContain('<li class="diff-block-del">Beta</li>');
    expectValidDiffOutput(r.html);
  });

  it('shows a moved paragraph as a delete plus an add', () => {
    const r = diff('<p>A</p>\n<p>B</p>', '<p>B</p>\n<p>A</p>');
    expect(r.changed).toBe(true);
    expect(r.html).toContain('diff-block-del');
    expect(r.html).toContain('diff-block-add');
  });

  it('replaces a changed code block whole instead of word diffing it', () => {
    const r = diff('<pre><code>let x = 1\n</code></pre>', '<pre><code>let x = 2\n</code></pre>');
    expect(r.html).toContain('<pre class="diff-block-del">');
    expect(r.html).toContain('<pre class="diff-block-add">');
    expect(r.html).not.toContain('<span class="diff-add">2</span>');
  });

  it('keeps an author strikethrough distinguishable from a deletion', () => {
    const r = diff('<p>a <del>b</del></p>', '<p>a <del>b</del> c</p>');
    expect(r.html).toContain('<del>b</del>');
    expect(r.html).toContain('<span class="diff-add">c</span>');
    expect(r.html).not.toContain('<del class="diff-del">b</del>');
  });

  it('marks a changed table cell without breaking the table', () => {
    const r = diff(
      '<table>\n<tbody><tr>\n<td>old</td>\n</tr>\n</tbody></table>',
      '<table>\n<tbody><tr>\n<td>new</td>\n</tr>\n</tbody></table>',
    );
    expect(r.html).toContain('<span class="diff-add">new</span>');
    expectValidDiffOutput(r.html);
  });

  it('handles an empty old body as pure insertion', () => {
    const r = diff('', '<p>first</p>');
    expect(r.html).toContain('<p class="diff-block-add">first</p>');
    expect(r.removed).toBe(0);
  });

  it('degrades instead of throwing when a stored body cannot be parsed', () => {
    // A row damaged before it was stored. The parser is right to refuse it, but one
    // bad row must not break the history view for the whole post.
    const r = diff('<p>fine</p>', '<p>broken <img src=x onerror=alert(1)></p>');
    expect(r).toMatchObject({ degraded: true, changed: true, added: 0, removed: 0 });
    expect(r.html).toBe('');
  });

  it('never reports degraded for input the parser accepts', () => {
    for (const [a, b] of [
      ['<p>a</p>', '<p>b</p>'],
      ['<p>same</p>', '<p>same</p>'],
      ['', '<p>first</p>'],
    ] as [string, string][]) {
      expect(richDiff(a, b).degraded).toBe(false);
    }
  });
});

describe('richDiff invariants', () => {
  const pairs: [string, string][] = [
    ['<p>a</p>', '<p>b</p>'],
    ['<ul>\n<li>a</li>\n<li>b</li>\n</ul>', '<ul>\n<li>b</li>\n</ul>'],
    ['<blockquote>\n<p>q</p>\n</blockquote>', '<p>q</p>'],
    ['<p>a <em>b</em></p>', '<p><strong>a</strong> b</p>'],
    ['<h2>t</h2>\n<p>x</p>', '<h3>t</h3>\n<p>x y</p>'],
    ['<p>a</p>\n<p>b</p>', '<p>b</p>\n<p>a</p>'],
  ];

  it('emits output that validates against the output grammar', () => {
    for (const [a, b] of pairs) {
      expectValidDiffOutput(richDiff(a, b).html);
      expectValidDiffOutput(richDiff(b, a).html);
    }
  });

  it('is symmetric in its counts', () => {
    for (const [a, b] of pairs) {
      const forward = richDiff(a, b);
      const back = richDiff(b, a);
      expect(forward.added).toBe(back.removed);
      expect(forward.removed).toBe(back.added);
    }
  });
});
