import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { env } from 'cloudflare:workers';
import { getCategories } from '../../config/categories.js';
import { listIndexableDrepIds } from '../lib/db/dreps.js';

export const prerender = false;

// Dynamic sitemap for the forum. A static build-time sitemap would go stale as
// topics are created, so this is rendered per request from the live data.
//
// No XML escaping is needed on the URLs: the origin is our own constant and all
// slugs are restricted to [a-z0-9-] by slugify(), so no value can contain a
// character that is special in XML.
export const GET: APIRoute = async ({ site }) => {
  const origin = site?.origin ?? 'https://dreptalk.com';

  const entries: Array<{ path: string; lastmod?: string }> = [
    { path: '/' },
    { path: '/register-drep/' },
    { path: '/badges/' },
    { path: '/help/' },
    ...(await getCollection('guides')).map((g) => ({
      path: `/help/${g.id}/`,
      ...(g.data.updated ? { lastmod: g.data.updated.toISOString() } : {}),
    })),
    { path: '/glossary/' },
    ...(await getCollection('glossary')).map((g) => ({
      path: `/glossary/${g.id}/`,
      ...(g.data.updated ? { lastmod: g.data.updated.toISOString() } : {}),
    })),
    ...getCategories().map((c) => ({ path: `/c/${c.slug}/` })),
  ];

  const db = env.DB as D1Database | undefined;
  if (db) {
    const rows =
      (
        await db
          .prepare('SELECT slug, last_post_at FROM topics WHERE deleted = 0 ORDER BY last_post_at DESC LIMIT 5000')
          .all<{ slug: string; last_post_at: number }>()
      ).results ?? [];
    // last_post_at is stored in milliseconds (same as created_at).
    for (const row of rows) {
      entries.push({ path: `/t/${row.slug}/`, lastmod: new Date(row.last_post_at).toISOString() });
    }
    for (const id of await listIndexableDrepIds(db)) {
      entries.push({ path: `/dreps/${id}/` });
    }
  }

  const urls = entries
    .map((e) => {
      const lastmod = e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : '';
      return `  <url><loc>${origin}${e.path}</loc>${lastmod}</url>`;
    })
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
