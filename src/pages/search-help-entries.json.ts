// Build-time list of the palette's Help group (guide and glossary titles), fetched
// by the header search palette when it first loads. Serving it as a static file
// keeps it out of every page's HTML.
import type { APIRoute } from 'astro';
import { getHelpEntries } from '@/lib/search/helpEntries.js';

export const prerender = true;

export const GET: APIRoute = async () =>
  new Response(JSON.stringify(await getHelpEntries()), {
    headers: { 'content-type': 'application/json' },
  });
