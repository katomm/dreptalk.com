// GET /og/treasury/recipients/:address.png
//
// Open Graph card of one treasury recipient address, rendered on demand and
// cached by its content-addressed URL. A malformed address: 404, a valid one
// that no withdrawal names gets an empty card.
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { parseStakeAddress } from '@/lib/governance/treasuryWithdrawals.js';
import { emptyRecipientCardModel, recipientCardModel } from '@/lib/og/recipientsCard.js';
import { renderOgCard } from '@/lib/og/render.js';
import { recipientCardHtml } from '@/lib/og/templates.js';
import { loadRecipientPage } from '@/lib/treasury/recipientsPage.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const cfg = currentNetwork();
  const address = params.address;
  if (!db || !address || !parseStakeAddress(address, cfg.network).ok) return new Response('Not found', { status: 404 });
  // The DB read and grouping run only on a cache miss.
  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, async () => {
    const page = await loadRecipientPage(db, cfg, address);
    return recipientCardHtml(page ? recipientCardModel(page.summary, page.label) : emptyRecipientCardModel(address));
  });
};
