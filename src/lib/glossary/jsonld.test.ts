import { describe, it, expect } from 'vitest';
import { buildGlossaryBreadcrumbLd, buildDefinedTermLd } from './jsonld.js';

const ORIGIN = 'https://dreptalk.com';

describe('buildGlossaryBreadcrumbLd', () => {
  it('builds a 3-level breadcrumb to the entry', () => {
    const ld = buildGlossaryBreadcrumbLd(ORIGIN, 'drep', 'DRep');
    expect(ld['@type']).toBe('BreadcrumbList');
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({
      position: 3,
      name: 'DRep',
      item: 'https://dreptalk.com/glossary/drep/',
    });
    expect(items[1].item).toBe('https://dreptalk.com/glossary/');
  });
});

describe('buildDefinedTermLd', () => {
  it('builds a DefinedTerm inside the glossary term set', () => {
    const ld = buildDefinedTermLd(ORIGIN, 'drep', 'DRep', 'Desc');
    expect(ld['@type']).toBe('DefinedTerm');
    expect(ld.name).toBe('DRep');
    expect(ld.description).toBe('Desc');
    expect(ld.url).toBe('https://dreptalk.com/glossary/drep/');
    const set = ld.inDefinedTermSet as Record<string, unknown>;
    expect(set['@type']).toBe('DefinedTermSet');
    expect(set.url).toBe('https://dreptalk.com/glossary/');
    expect('dateModified' in ld).toBe(false);
  });

  it('includes dateModified when updated is given', () => {
    const ld = buildDefinedTermLd(ORIGIN, 'x', 'T', 'D', new Date('2026-07-14T00:00:00Z'));
    expect(ld.dateModified).toBe('2026-07-14');
  });
});
