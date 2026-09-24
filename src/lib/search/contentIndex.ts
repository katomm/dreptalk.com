// The content search index: help guides, glossary terms and Governance Review
// editions, flattened to plain text. The collections are immutable per deploy,
// so the index is built once per isolate and reused by every search request.
import { getCollection } from 'astro:content';
import { cardTeaser, editionSlug } from '../review/editions.js';
import { editionPath } from '../review/windows.js';
import { extractHeadings, flattenMarkdown, indexContent, type ContentDoc, type IndexedDoc } from './content.js';

let cached: Promise<IndexedDoc[]> | undefined;

async function build(): Promise<IndexedDoc[]> {
  const [guides, glossary, review] = await Promise.all([getCollection('guides'), getCollection('glossary'), getCollection('review')]);
  const docs: ContentDoc[] = [
    ...guides.map((g): ContentDoc => {
      // FAQ answers render on the guide page, so they are searchable text too.
      const faqs = (g.data.faqs ?? []).map((f) => `${f.q} ${f.a}`).join(' ');
      return {
        kind: 'help',
        title: g.data.title,
        href: `/help/${g.id}/`,
        headings: extractHeadings(g.body ?? ''),
        text: `${flattenMarkdown(g.body ?? '')} ${flattenMarkdown(faqs)}`.trim(),
        description: g.data.description,
        detail: 'Guide',
      };
    }),
    ...glossary.map(
      (g): ContentDoc => ({
        kind: 'help',
        title: g.data.term,
        href: `/glossary/${g.id}/`,
        headings: extractHeadings(g.body ?? ''),
        text: flattenMarkdown(g.body ?? ''),
        description: g.data.description,
        detail: 'Glossary',
      }),
    ),
    ...review.map((e): ContentDoc => {
      const d = e.data;
      // The action tables come from frontmatter, not the body, and name every
      // action the window decided, so their titles are searchable as well.
      const actions = [...d.alsoDecided, ...d.openActions].map((r) => r.title).join('. ');
      return {
        kind: 'reviews',
        title: d.title,
        href: editionPath(editionSlug(e)),
        headings: extractHeadings(e.body ?? ''),
        text: `${d.standfirst} ${flattenMarkdown(e.body ?? '')} ${actions}`.trim(),
        description: cardTeaser(e),
        detail: `Epochs ${d.epochFrom} to ${d.epochTo}`,
        order: d.epochTo,
      };
    }),
  ];
  return indexContent(docs);
}

export function getContentIndex(): Promise<IndexedDoc[]> {
  // A failed build is not cached, so the next request retries it.
  cached ??= build().catch((err) => {
    cached = undefined;
    throw err;
  });
  return cached;
}
