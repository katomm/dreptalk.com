// GET /llms.txt: a curated markdown index of the site for language models,
// generated from the content collections so it cannot go stale when a guide or
// Governance Review edition is added. Prerendered: the collections are build
// time data, so the file is a static asset with no per-request cost.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { renderLlmsText } from '@/lib/llms/text';

export const prerender = true;

export const GET: APIRoute = async ({ site }) => {
  const origin = site?.origin ?? 'https://dreptalk.com';
  const [guides, glossary, review] = await Promise.all([
    getCollection('guides'),
    getCollection('glossary'),
    getCollection('review'),
  ]);
  const text = renderLlmsText(origin, {
    guides: guides.map((g) => ({ id: g.id, ...g.data })),
    glossary: glossary.map((g) => ({ id: g.id, ...g.data })),
    editions: review.map((e) => e.data),
  });
  return new Response(text, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
};
