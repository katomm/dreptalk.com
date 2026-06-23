// Pure JSON-LD builders for help guides. Kept free of Astro APIs so they are
// unit-testable and reused by the guide route.

export interface Faq {
  q: string;
  a: string;
}

// ISO date without the time part, e.g. "2026-06-23".
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function buildBreadcrumbLd(origin: string, slug: string, cardLabel: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'DRepTalk', item: `${origin}/` },
      { '@type': 'ListItem', position: 2, name: 'Help', item: `${origin}/help` },
      { '@type': 'ListItem', position: 3, name: cardLabel, item: `${origin}/help/${slug}` },
    ],
  };
}

export function buildArticleLd(
  origin: string,
  slug: string,
  title: string,
  description: string,
  updated?: Date,
): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    url: `${origin}/help/${slug}`,
    inLanguage: 'en',
    publisher: { '@type': 'Organization', name: 'DRepTalk', url: origin },
  };
  if (updated) ld.dateModified = isoDate(updated);
  return ld;
}

export function buildFaqLd(faqs: Faq[] | undefined): Record<string, unknown> | null {
  if (!faqs || faqs.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}
