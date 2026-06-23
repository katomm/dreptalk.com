import { describe, it, expect } from 'vitest';
import { buildBreadcrumbLd, buildArticleLd, buildFaqLd } from './jsonld.js';

const ORIGIN = 'https://dreptalk.com';

describe('buildBreadcrumbLd', () => {
  it('builds a 3-level breadcrumb to the guide', () => {
    const ld = buildBreadcrumbLd(ORIGIN, 'open-source', 'Open source') as any;
    expect(ld['@type']).toBe('BreadcrumbList');
    expect(ld.itemListElement).toHaveLength(3);
    expect(ld.itemListElement[2]).toMatchObject({
      position: 3,
      name: 'Open source',
      item: 'https://dreptalk.com/help/open-source',
    });
    expect(ld.itemListElement[1].item).toBe('https://dreptalk.com/help');
  });
});

describe('buildArticleLd', () => {
  it('builds an Article with url and headline', () => {
    const ld = buildArticleLd(ORIGIN, 'open-source', 'Open source - DRepTalk', 'Desc') as any;
    expect(ld['@type']).toBe('Article');
    expect(ld.headline).toBe('Open source - DRepTalk');
    expect(ld.description).toBe('Desc');
    expect(ld.url).toBe('https://dreptalk.com/help/open-source');
    expect(ld.inLanguage).toBe('en');
    expect('dateModified' in ld).toBe(false);
  });

  it('includes dateModified when updated is given', () => {
    const ld = buildArticleLd(ORIGIN, 'x', 'T', 'D', new Date('2026-06-23T00:00:00Z')) as any;
    expect(ld.dateModified).toBe('2026-06-23');
  });
});

describe('buildFaqLd', () => {
  it('returns null for empty input', () => {
    expect(buildFaqLd([])).toBeNull();
    expect(buildFaqLd(undefined as any)).toBeNull();
  });

  it('builds a FAQPage with Question/Answer entries', () => {
    const ld = buildFaqLd([{ q: 'Q1', a: 'A1' }]) as any;
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.mainEntity[0]).toMatchObject({
      '@type': 'Question',
      name: 'Q1',
      acceptedAnswer: { '@type': 'Answer', text: 'A1' },
    });
  });
});
