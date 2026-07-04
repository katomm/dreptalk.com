import { describe, it, expect } from 'vitest';
import { flattenMarkdown, extractHeadings, searchHelp, type HelpDoc } from './help.js';

const docs: HelpDoc[] = [
  {
    title: 'Delegating your stake',
    href: '/help/delegating',
    headings: ['How to delegate'],
    text: 'You can delegate your voting power to a DRep of your choice.',
  },
  {
    title: 'Becoming a DRep',
    href: '/help/become-drep',
    headings: ['Registration'],
    text: 'Register a DRep certificate to represent delegators.',
  },
];

describe('flattenMarkdown', () => {
  it('strips markdown syntax', () => {
    expect(flattenMarkdown('# Title\n\nSome **bold** and [link](/x).')).toBe('Title Some bold and link.');
  });
  it('drops fenced code blocks', () => {
    expect(flattenMarkdown('intro\n```js\nconst x = 1;\n```\nafter')).toBe('intro after');
  });
});

describe('extractHeadings', () => {
  it('pulls ATX headings', () => {
    expect(extractHeadings('# A\ntext\n## B\n')).toEqual(['A', 'B']);
  });
});

describe('searchHelp', () => {
  it('ranks a match and returns a highlighted snippet', () => {
    const hits = searchHelp(docs, 'delegate');
    expect(hits[0].href).toBe('/help/delegating');
    expect(hits[0].snippet).toContain('delegate');
  });
  it('returns empty for no match', () => {
    expect(searchHelp(docs, 'zzzznope')).toEqual([]);
  });
  it('matches title terms', () => {
    const hits = searchHelp(docs, 'becoming');
    expect(hits.map((h) => h.href)).toContain('/help/become-drep');
  });
  it('returns empty for an empty query', () => {
    expect(searchHelp(docs, '   ')).toEqual([]);
  });
});
