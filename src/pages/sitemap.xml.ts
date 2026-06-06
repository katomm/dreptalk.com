import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCategories } from '../../config/categories.js';

export const prerender = false;

// Dynamic sitemap for the forum. A static build-time sitemap would go stale as
// topics are created, so this is rendered per request from the live data.
//
// No XML escaping is needed on the URLs: the origin is our own constant and all
// slugs are restricted to [a-z0-9-] by slugify(), so no value can contain a
// character that is special in XML.
export const GET: APIRoute = async ({ site }) => {
  const origin = site?.origin ?? 'https://dreptalk.com';

  const paths: string[] = ['/', ...getCategories().map((c) => `/c/${c.slug}`)];

  const db = env.DB as D1Database | undefined;
  if (db) {
    const rows =
      (
        await db
          .prepare('SELECT slug FROM topics WHERE deleted = 0 ORDER BY last_post_at DESC LIMIT 5000')
          .all<{ slug: string }>()
      ).results ?? [];
    for (const row of rows) paths.push(`/t/${row.slug}`);
  }

  const urls = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
