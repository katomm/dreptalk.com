// Build-time static index of the guides and glossary collections, fetched by
// the palette and the /search page to search help content client-side.
// Prerendered: it is a static asset, no per-request cost.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { flattenMarkdown, extractHeadings, type HelpDoc } from '@/lib/search/help';

export const prerender = true;

export const GET: APIRoute = async () => {
  const guides = await getCollection('guides');
  const glossary = await getCollection('glossary');
  const docs: HelpDoc[] = [
    ...guides.map((g) => {
      const md = g.body ?? '';
      return {
        title: g.data.title,
        href: `/help/${g.id}/`,
        headings: extractHeadings(md),
        text: flattenMarkdown(md),
      };
    }),
    ...glossary.map((g) => {
      const md = g.body ?? '';
      return {
        title: g.data.term,
        href: `/glossary/${g.id}/`,
        headings: extractHeadings(md),
        text: flattenMarkdown(md),
      };
    }),
  ];
  return new Response(JSON.stringify(docs), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
  });
};
