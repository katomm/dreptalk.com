// GET /og/t/:slug.png
//
// Dynamic Open Graph card for a governance-action thread, rendered on demand and
// cached. Keyed by the topic slug (the on-chain ga_id contains '#', so it is not
// URL-safe). A non-governance or unknown slug 404s; the page then keeps its
// static category card.
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { epochStartMs } from '@/lib/config/network.js';
import { getGovernanceActionByTopicId } from '@/lib/db/governance.js';
import { getTopicBySlug } from '@/lib/db/forum.js';
import { proposerView } from '@/lib/identity/proposer.js';
import { loadLogo } from '@/lib/og/assets.js';
import { loadOgFonts } from '@/lib/og/fonts.js';
import { govCardModel } from '@/lib/og/model.js';
import { ogPng } from '@/lib/og/render.js';
import { govCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const slug = params.slug;
  if (!db || !slug) return new Response('Not found', { status: 404 });

  const topic = await getTopicBySlug(db, slug);
  const action = topic ? await getGovernanceActionByTopicId(db, topic.id) : null;
  if (!action) return new Response('Not found', { status: 404 });

  const net = currentNetwork();
  const expiryUnixMs = action.expiryEpoch != null ? epochStartMs(action.expiryEpoch, net) : null;
  const pv = proposerView(action.returnAddress);
  const model = govCardModel(action, {
    expiryUnixMs,
    now: Date.now(),
    proposerName: pv.kind === 'known' ? pv.name : null,
  });

  const [fonts, logo] = await Promise.all([
    loadOgFonts(env.ASSETS as unknown as Fetcher, request.url),
    loadLogo(env.ASSETS as unknown as Fetcher, request.url),
  ]);
  return ogPng(govCardHtml(model, logo), fonts);
};
