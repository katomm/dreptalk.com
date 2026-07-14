import { describe, it, expect } from 'vitest';
import { buildBreadcrumbLd } from './breadcrumb.js';

const ORIGIN = 'https://dreptalk.com';

describe('buildBreadcrumbLd', () => {
  it('builds a breadcrumb rooted at DRepTalk', () => {
    const ld = buildBreadcrumbLd(ORIGIN, [
      { name: 'Help', path: '/help/' },
      { name: 'Open source', path: '/help/open-source/' },
    ]);
    expect(ld['@type']).toBe('BreadcrumbList');
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ position: 1, name: 'DRepTalk', item: 'https://dreptalk.com/' });
    expect(items[1]).toMatchObject({ position: 2, name: 'Help', item: 'https://dreptalk.com/help/' });
    expect(items[2]).toMatchObject({
      position: 3,
      name: 'Open source',
      item: 'https://dreptalk.com/help/open-source/',
    });
  });

  it('numbers positions sequentially for other sections', () => {
    const ld = buildBreadcrumbLd(ORIGIN, [
      { name: 'Glossary', path: '/glossary/' },
      { name: 'DRep', path: '/glossary/drep/' },
    ]);
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(items[2].item).toBe('https://dreptalk.com/glossary/drep/');
  });
});
