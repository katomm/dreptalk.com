import { describe, it, expect } from 'vitest';
import { flattenMarkdown, extractHeadings, indexContent, searchContent, type ContentDoc } from './content.js';
import { parseSnippet } from './snippet.js';

const docs = indexContent([
  {
    kind: 'help',
    title: 'Delegating your stake',
    href: '/help/delegating/',
    headings: ['How to delegate'],
    text: 'You can delegate your voting power to a DRep of your choice.',
    description: 'Pick a DRep for your stake.',
    detail: 'Guide',
  },
  {
    kind: 'help',
    title: 'Becoming a DRep',
    href: '/help/become-drep/',
    headings: ['Registration'],
    text: 'Register a DRep certificate to represent delegators. The deposit is devoted to nothing.',
    detail: 'Guide',
  },
  {
    kind: 'reviews',
    title: 'The treasury pays out twice',
    href: '/governance-review/epochs-600-602/',
    headings: ['Two withdrawals'],
    text: 'Two treasury withdrawals were enacted while DReps voted on the budget.',
    description: 'Two withdrawals in three epochs.',
    detail: 'Edition 30',
    order: 602,
  },
  {
    kind: 'reviews',
    title: 'A quiet window',
    href: '/governance-review/epochs-603-605/',
    headings: [],
    text: 'Nothing moved the treasury except one withdrawal.',
    detail: 'Edition 31',
    order: 605,
  },
] satisfies ContentDoc[]);

describe('flattenMarkdown', () => {
  it('strips markdown syntax', () => {
    expect(flattenMarkdown('# Title\n\nSome **bold** and [link](/x).')).toBe('Title Some bold and link.');
  });
  it('drops fenced code blocks, including review charts', () => {
    expect(flattenMarkdown('intro\n```chart\ntype: matrix\n```\nafter')).toBe('intro after');
  });
  it('drops list bullets and table rules but keeps hyphenated words', () => {
    expect(flattenMarkdown('- a well-known item\n\n| A | B |\n|---|---|\n| 1 | 2 |')).toBe('a well-known item A B 1 2');
  });
});

describe('extractHeadings', () => {
  it('pulls ATX headings', () => {
    expect(extractHeadings('# A\ntext\n## B\n')).toEqual(['A', 'B']);
  });
});

describe('searchContent', () => {
  it('splits hits into help and reviews', () => {
    const r = searchContent(docs, 'treasury');
    expect(r.help).toEqual([]);
    expect(r.reviews.map((h) => h.href)).toEqual(['/governance-review/epochs-600-602/', '/governance-review/epochs-603-605/']);
  });

  it('ranks a title match above a body match', () => {
    const r = searchContent(docs, 'delegat');
    expect(r.help[0].href).toBe('/help/delegating/');
  });

  it('breaks score ties newest first', () => {
    const twins = indexContent([
      { kind: 'reviews', title: 'Older', href: '/old/', headings: [], text: 'quorum', order: 510 },
      { kind: 'reviews', title: 'Newer', href: '/new/', headings: [], text: 'quorum', order: 650 },
    ]);
    expect(searchContent(twins, 'quorum').reviews.map((h) => h.href)).toEqual(['/new/', '/old/']);
  });

  it('requires every token, like the ANDed D1 match', () => {
    expect(searchContent(docs, 'treasury delegate').reviews).toEqual([]);
    expect(searchContent(docs, 'treasury budget').reviews).toHaveLength(1);
  });

  it('matches word starts, not inner substrings', () => {
    // "devoted" contains "vote" but does not start with it.
    const r = searchContent(docs, 'vote');
    expect(r.help.map((h) => h.href)).not.toContain('/help/become-drep/');
    expect(r.reviews.map((h) => h.href)).toContain('/governance-review/epochs-600-602/');
  });

  it('folds case and diacritics', () => {
    expect(searchContent(docs, 'TRÉASURY').reviews).toHaveLength(2);
  });

  it('keeps the original casing in snippets of text with multi-char folds', () => {
    const one = indexContent([
      { kind: 'reviews', title: 'Edition', href: '/e/', headings: [], text: 'Wait… The Treasury Withdrawal ﬁnally passed.' },
    ]);
    const [hit] = searchContent(one, 'treasury').reviews;
    expect(hit.snippet).toBe('Wait… The \u0001Treasury\u0002 Withdrawal ﬁnally passed.');
  });

  it('highlights every query token inside the snippet', () => {
    const [hit] = searchContent(docs, 'voting power').help;
    const marked = parseSnippet(hit.snippet ?? '')
      .filter((s) => s.match)
      .map((s) => s.text);
    expect(marked).toEqual(['voting', 'power']);
  });

  it('opens the snippet where the query tokens appear together', () => {
    const one = indexContent([
      {
        kind: 'reviews',
        title: 'Edition',
        href: '/e/',
        headings: [],
        text: `A minimum viable governance plan. ${'Filler words go here. '.repeat(10)}The minimum pool fee stays at 170 ada.`,
      },
    ]);
    const [hit] = searchContent(one, 'minimum pool fee').reviews;
    const marked = parseSnippet(hit.snippet ?? '')
      .filter((s) => s.match)
      .map((s) => s.text);
    expect(marked).toEqual(['minimum', 'pool', 'fee']);
  });

  it('falls back to the description when only the title matched', () => {
    const [hit] = searchContent(docs, 'becoming').help;
    expect(hit.snippet).toBeNull();
    expect(hit.description).toBeNull(); // this doc has none
    const [withDesc] = searchContent(docs, 'stake').help;
    expect(withDesc.snippet).toBeNull();
    expect(withDesc.description).toBe('Pick a DRep for your stake.');
    expect(withDesc.detail).toBe('Guide');
  });

  it('returns nothing for an empty or unmatched query', () => {
    expect(searchContent(docs, '   ')).toEqual({ help: [], reviews: [] });
    expect(searchContent(docs, 'zzzznope')).toEqual({ help: [], reviews: [] });
  });
});
