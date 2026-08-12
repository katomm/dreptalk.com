// src/pages/sitemap-cip100.xml.ts
// GET /sitemap-cip100.xml
// Lists thread manifests, not snapshots. Snapshots are unbounded and immutable,
// so listing them would grow without limit and tell a crawler nothing the
// manifest does not already say.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { currentNetwork } from '@/lib/api/response';
import { originForNetwork } from '@/lib/cip100/origin';

export const prerender = false;

export const GET: APIRoute = async () => {
  // Not Astro.site: astro.config.mjs hardcodes site: 'https://dreptalk.com' and
  // the preprod build does not override it, so site.origin would publish
  // mainnet URLs from preprod. Every emitted URL in this feature comes from
  // originForNetwork, and this sitemap is no exception.
  const origin = originForNetwork(currentNetwork().network === 'preprod' ? 'preprod' : 'mainnet');
  const db = env.DB as D1Database | undefined;
  const rows = db
    ? (
        await db
          .prepare(
            `SELECT id, last_post_at FROM topics
              WHERE deleted = 0 ORDER BY last_post_at DESC LIMIT 5000`,
          )
          .all<{ id: string; last_post_at: number }>()
      ).results ?? []
    : [];

  // Topic ids are UUIDs and the origin is our own constant, so no value here can
  // contain a character that is special in XML.
  const urls = rows
    .map(
      (r) =>
        `  <url><loc>${origin}/cip100/topic/${r.id}.json</loc><lastmod>${new Date(r.last_post_at).toISOString()}</lastmod></url>`,
    )
    .join('\n');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } },
  );
};
