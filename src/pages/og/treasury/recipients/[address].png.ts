// GET /og/treasury/recipients/:address.png
//
// Open Graph card of one treasury recipient address, rendered on demand and
// cached by its content-addressed URL. Unknown address: 404.
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { recipientCardModel } from '@/lib/og/recipientsCard.js';
import { renderOgCard } from '@/lib/og/render.js';
import { recipientCardHtml } from '@/lib/og/templates.js';
import { loadRecipientPage } from '@/lib/treasury/recipientsPage.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db || !params.address) return new Response('Not found', { status: 404 });
  const page = await loadRecipientPage(db, currentNetwork(), params.address);
  if (!page) return new Response('Not found', { status: 404 });
  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, () => recipientCardHtml(recipientCardModel(page.summary, page.label)));
};
