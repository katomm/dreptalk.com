// GET /og/treasury/recipients.png
//
// Open Graph card of the treasury recipients overview, rendered on demand and
// cached by its content-addressed URL (the page versions it by the whole model).
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { recipientsCardModel } from '@/lib/og/recipientsCard.js';
import { renderOgCard } from '@/lib/og/render.js';
import { recipientsCardHtml } from '@/lib/og/templates.js';
import { loadRecipientsPage } from '@/lib/treasury/recipientsPage.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('Not found', { status: 404 });
  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, async () => {
    const data = await loadRecipientsPage(db, currentNetwork(), Math.floor(Date.now() / 1000));
    return recipientsCardHtml(recipientsCardModel(data));
  });
};
