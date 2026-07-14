// Pure JSON-LD builders for glossary entries. Kept free of Astro APIs so they
// are unit-testable and reused by the entry route.

import { isoDate } from '../format/date.js';

export function buildGlossaryBreadcrumbLd(origin: string, slug: string, term: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'DRepTalk', item: `${origin}/` },
      { '@type': 'ListItem', position: 2, name: 'Glossary', item: `${origin}/glossary/` },
      { '@type': 'ListItem', position: 3, name: term, item: `${origin}/glossary/${slug}/` },
    ],
  };
}

export function buildDefinedTermLd(
  origin: string,
  slug: string,
  term: string,
  description: string,
  updated?: Date,
): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'DefinedTerm',
    name: term,
    description,
    url: `${origin}/glossary/${slug}/`,
    inLanguage: 'en',
    inDefinedTermSet: {
      '@type': 'DefinedTermSet',
      name: 'Cardano governance glossary',
      url: `${origin}/glossary/`,
    },
  };
  if (updated) ld.dateModified = isoDate(updated);
  return ld;
}
