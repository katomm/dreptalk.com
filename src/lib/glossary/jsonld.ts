// Pure JSON-LD builder for glossary entries. Kept free of Astro APIs so it is
// unit-testable. Breadcrumbs come from the shared builder in lib/jsonld.

import { isoDate } from '../format/date.js';

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
