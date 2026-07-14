// Generic BreadcrumbList builder shared by the content sections (help,
// glossary). Kept free of Astro APIs so it is unit-testable.

export interface Crumb {
  name: string;
  path: string;
}

export function buildBreadcrumbLd(origin: string, crumbs: Crumb[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'DRepTalk', item: `${origin}/` },
      ...crumbs.map((c, i) => ({
        '@type': 'ListItem',
        position: i + 2,
        name: c.name,
        item: `${origin}${c.path}`,
      })),
    ],
  };
}
