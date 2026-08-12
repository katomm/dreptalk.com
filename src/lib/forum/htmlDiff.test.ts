import { describe, it, expect } from 'vitest';
import { DIFF_CLASSES } from '../sanitizedHtmlGrammar.js';
import { richDiff } from './htmlDiff.js';
import { parseSanitizedHtml } from './htmlNodes.js';

// Content model for the handful of tags whose children are structurally restricted.
// Everywhere else (p, li, td, th, inline tags, the diff spans themselves) any child
// is accepted here: that looseness is already covered by the tag/attribute check
// below, this table only encodes what parseSanitizedHtml does not, the shape of
// nesting. Void tags (br, hr) never open a scope.
const CONTENT_MODEL: Readonly<Record<string, ReadonlySet<string>>> = {
  ul: new Set(['li']),
  ol: new Set(['li']),
  table: new Set(['thead', 'tbody']),
  thead: new Set(['tr']),
  tbody: new Set(['tr']),
  tr: new Set(['th', 'td']),
};
const VOID_TAGS = new Set(['br', 'hr']);

/**
 * A small stack-based scan of the raw diff output, independent of the production
 * parser, so it can assert what that parser deliberately does not check: the content
 * model. parseSanitizedHtml only verifies that tags and attributes are individually
 * legal and that open and close tags match, so `<ul><span class="diff-add">x</span>
 * <li>a</li></ul>` parses cleanly even though no browser agrees a <span> belongs
 * directly inside a <ul>. This walks the tag stream itself and asserts, for every
 * tag with a restricted content model, that only its allowed children (and
 * whitespace) appear directly inside it.
 */
function assertValidContentModel(html: string): void {
  const TOKEN = /<\/([a-z0-9]+)>|<([a-z0-9]+)(?:\s+[a-z-]+="[^"]*")*\s*>/gi;
  const stack: string[] = [];
  let cursor = 0;
  let m = TOKEN.exec(html);
  const checkText = (text: string): void => {
    const parent = stack[stack.length - 1];
    if (parent && CONTENT_MODEL[parent]) expect(text.trim()).toBe('');
  };
  while (m) {
    if (m.index > cursor) checkText(html.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    const closing = m[1]?.toLowerCase();
    const opening = m[2]?.toLowerCase();
    if (closing) {
      stack.pop();
    } else if (opening) {
      const parent = stack[stack.length - 1];
      if (parent && CONTENT_MODEL[parent]) {
        expect(CONTENT_MODEL[parent].has(opening)).toBe(true);
      }
      if (!VOID_TAGS.has(opening)) stack.push(opening);
    }
    m = TOKEN.exec(html);
  }
  if (cursor < html.length) checkText(html.slice(cursor));
}

/**
 * The output grammar is the input grammar plus span[class=<diff class>] plus a diff
 * class on any allowed element. Assert that, assert the content model holds for the
 * marked output as-is, then strip the additions and require the remainder to be
 * valid input-grammar HTML.
 */
function expectValidDiffOutput(html: string): void {
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    expect(DIFF_CLASSES.has(m[1])).toBe(true);
  }
  assertValidContentModel(html);
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

  it('word-diffs a cell rewritten to words the old one did not share', () => {
    // Cells pair by column, not by similarity. "80k" and "90k" share no words, so a
    // similarity match rejects the pair and replaces the cell whole, which renders as
    // a deleted cell beside an added one: a row with more cells than the header has
    // columns. Every number, date or one-word status in a table lands here.
    const r = diff(
      '<table>\n<tbody>\n<tr>\n<td>Audit</td>\n<td>80k</td>\n</tr>\n</tbody>\n</table>',
      '<table>\n<tbody>\n<tr>\n<td>Audit</td>\n<td>90k</td>\n</tr>\n</tbody>\n</table>',
    );
    expect(r.html).toContain('<span class="diff-del">80k</span>');
    expect(r.html).toContain('<span class="diff-add">90k</span>');
    expect(r.html).not.toContain('diff-block-del');
    expect((r.html.match(/<td/g) ?? []).length).toBe(2);
    expectValidDiffOutput(r.html);
  });

  it('shows an added column as one added cell', () => {
    const r = diff(
      '<table>\n<tbody>\n<tr>\n<td>a</td>\n</tr>\n</tbody>\n</table>',
      '<table>\n<tbody>\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n</tbody>\n</table>',
    );
    expect(r.html).toContain('<td class="diff-add">b</td>');
    expect((r.html.match(/<td/g) ?? []).length).toBe(2);
    expect(r).toMatchObject({ added: 1, removed: 0 });
    expectValidDiffOutput(r.html);
  });

  it('shows a removed column as one deleted cell', () => {
    const r = diff(
      '<table>\n<tbody>\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n</tbody>\n</table>',
      '<table>\n<tbody>\n<tr>\n<td>a</td>\n</tr>\n</tbody>\n</table>',
    );
    expect(r.html).toContain('<td class="diff-del">b</td>');
    expect(r).toMatchObject({ added: 0, removed: 1 });
    expectValidDiffOutput(r.html);
  });

  it('never emits a marker span as a direct child of a list or a table row', () => {
    // Raw HTML blocks pass through renderMarkdown largely unchecked, so a stored body
    // can already hold text that never belonged directly inside <ul> or <tr> to begin
    // with. That pre-existing invalidity is not this module's to fix, which is why
    // this test does not call expectValidDiffOutput: its content model check would
    // (correctly) reject these fixtures on that basis alone, span or no span, so it
    // cannot distinguish the two. What diffing must not do is compound the existing
    // problem by adding a <span>, which is not legal content there either, and inside
    // a table a browser foster-parents it out entirely, moving the marked words to
    // before the table on the rendered page.
    //
    // alpha and beta share no words, so alignNodes never pairs them: both fixtures
    // below exercise the old-only/new-only branches in diffNodeLists, not diffText's
    // own NO_SPAN_PARENTS branch (that one only runs when alignNodes does pair the
    // text, see the matched-path test further down).
    const list = diff('<ul>alpha<li>x</li></ul>', '<ul>beta<li>x</li></ul>');
    expect(list.html).not.toContain('<span');
    expect(list.html).toContain('beta');

    const table = diff(
      '<table><tbody><tr>alpha<td>x</td></tr></tbody></table>',
      '<table><tbody><tr>beta<td>x</td></tr></tbody></table>',
    );
    expect(table.html).not.toContain('<span');
    expect(table.html).toContain('beta');
  });

  it('still counts a word lost or gained even where the marker is withheld', () => {
    // The chosen trade for NO_SPAN_PARENTS is structure over highlighting, not
    // structure over honesty: a reader who sees "edited" with no marks and a zero
    // count has been told nothing happened. The count stays accurate even though the
    // word itself is not pointed at.
    //
    // One side has no text node at all here, so these two also exercise the
    // old-only/new-only branches, the same as the pair above, not diffText's own
    // NO_SPAN_PARENTS branch.
    const removed = diff('<ul>alpha<li>x</li></ul>', '<ul><li>x</li></ul>');
    expect(removed.html).not.toContain('<span');
    expect(removed).toMatchObject({ changed: true, added: 0, removed: 1 });

    const added = diff('<ul><li>x</li></ul>', '<ul>alpha<li>x</li></ul>');
    expect(added.html).not.toContain('<span');
    expect(added).toMatchObject({ changed: true, added: 1, removed: 0 });
  });

  it('counts a changed word even where the marker is withheld, when alignNodes pairs the text', () => {
    // Unlike the two tests above, "alpha bravo" and "alpha charlie" share one of two
    // words, enough to clear alignNodes' 0.3 similarity threshold, so this time the
    // text nodes land as a matched slot and go through diffText's own
    // NO_SPAN_PARENTS branch, not diffNodeLists' old-only/new-only branches. That
    // branch used to return the new text with no counting at all: a rewrite entirely
    // inside a <ul> would report added: 0, removed: 0 despite a real word changing.
    const r = diff('<ul>alpha bravo<li>x</li></ul>', '<ul>alpha charlie<li>x</li></ul>');
    expect(r.html).not.toContain('<span');
    expect(r.added).toBeGreaterThan(0);
    expect(r.removed).toBeGreaterThan(0);
  });

  it('word-diffs a lone paragraph rewritten to unrelated words, with no sibling to make it ambiguous', () => {
    // Pins one half of the single-candidate pairing's sibling-dependent asymmetry
    // documented in diffNodeLists: with no sibling, this is the only candidate on
    // each side, so it is paired and word-diffed even though the two texts share no
    // words at all.
    const r = diff('<p>Alpha beta gamma</p>', '<p>Totally unrelated words</p>');
    expect(r.html).not.toContain('diff-block-del');
    expect(r.html).not.toContain('diff-block-add');
    expect(r.html).toContain('<span class="diff-del">');
    expect(r.html).toContain('<span class="diff-add">');
  });

  it('replaces the same rewritten paragraph whole once a sibling makes the pairing ambiguous', () => {
    // The other half of the asymmetry: same rewrite, but now there are two children
    // on each side, so alignNodes runs its own multi-candidate similarity match
    // instead, and rejects the 0%-overlap pair, replacing the paragraph whole.
    const r = diff(
      '<p>Alpha beta gamma</p>\n<p>unchanged</p>',
      '<p>Totally unrelated words</p>\n<p>unchanged</p>',
    );
    expect(r.html).toContain('diff-block-del');
    expect(r.html).toContain('diff-block-add');
  });

  it('does not count words for a block tag swap with identical text', () => {
    const r = diff('<h2>t</h2>', '<h3>t</h3>');
    expect(r).toMatchObject({ added: 0, removed: 0 });
    expect(r.html).toContain('diff-block-del');
    expect(r.html).toContain('diff-block-add');
  });

  it('does not count words for a list type swap with identical items', () => {
    const r = diff('<ul>\n<li>a</li>\n<li>b</li>\n</ul>', '<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
    expect(r).toMatchObject({ added: 0, removed: 0 });
    expect(r.html).toContain('diff-block-del');
    expect(r.html).toContain('diff-block-add');
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

  it('degrades on an identical pair of bodies the parser cannot read', () => {
    // Two identical versions short-circuit before any parsing, which used to be the
    // only path that returned stored HTML unvalidated. For a post with a malformed
    // body that meant every version pair degraded except this one, which quietly
    // rendered the raw body instead.
    const broken = '<p>broken <img src=x onerror=alert(1)></p>';
    const r = diff(broken, broken);
    expect(r).toMatchObject({ degraded: true, added: 0, removed: 0 });
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

describe('expectValidDiffOutput content model', () => {
  it('rejects a marker span or a foreign block as a direct child of a list or a table', () => {
    // These four are hand-built, not real richDiff output: a reviewer fed them to the
    // pre-strengthening version of this helper, which stripped spans and checked
    // tags and attributes only, and all four passed silently. That is why the earlier
    // span-inside-a-list bug went unnoticed. Exercised directly against the helper so
    // its own strength is pinned independently of whatever richDiff happens to
    // produce today.
    const badExamples = [
      '<ul><span class="diff-add">orphan</span><li>a</li></ul>',
      '<table><tbody><tr><span class="diff-del">x</span><td>a</td></tr></tbody></table>',
      '<ol><span class="diff-add">not an li</span></ol>',
      '<ul><p class="diff-block-add">a p inside a ul</p></ul>',
    ];
    for (const html of badExamples) {
      expect(() => expectValidDiffOutput(html)).toThrow();
    }
  });
});
