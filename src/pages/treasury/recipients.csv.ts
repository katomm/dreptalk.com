// GET /treasury/recipients.csv
//
// Every treasury recipient address with paid and not paid amounts in lovelace,
// the same rows the recipients overview renders.
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { loadRecipientsPage, recipientsCsv } from '@/lib/treasury/recipientsPage.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('Not found', { status: 404 });
  const data = await loadRecipientsPage(db, currentNetwork(), Math.floor(Date.now() / 1000));
  return new Response(recipientsCsv(data), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="treasury-recipients.csv"',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
    },
  });
};
