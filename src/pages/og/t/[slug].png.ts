// GET /og/t/:slug.png
//
// Dynamic Open Graph card for a forum thread, rendered on demand and cached.
// Keyed by the topic slug (the on-chain ga_id contains '#', so it is not
// URL-safe). A synced governance action renders the action card; any other topic
// renders the discussion card. An unknown slug 404s and the page keeps the site
// default image.
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { epochStartMs } from '@/lib/config/network.js';
import { getOpeningPostBody, getTopicBySlug } from '@/lib/db/forum.js';
import { getGovernanceActionByTopicId } from '@/lib/db/governance.js';
import { loadAuthorIdentity } from '@/lib/forum/author.js';
import { proposerView } from '@/lib/identity/proposer.js';
import { loadAvatar } from '@/lib/og/assets.js';
import { discussionCardModel, govCardModel } from '@/lib/og/model.js';
import { renderOgCard } from '@/lib/og/render.js';
import { discussionCardHtml, govCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const slug = params.slug;
  if (!db || !slug) return new Response('Not found', { status: 404 });

  const topic = await getTopicBySlug(db, slug);
  if (!topic) return new Response('Not found', { status: 404 });

  const assets = env.ASSETS as unknown as Fetcher;
  const action = await getGovernanceActionByTopicId(db, topic.id);

  if (action) {
    const net = currentNetwork();
    const expiryUnixMs = action.expiryEpoch != null ? epochStartMs(action.expiryEpoch, net) : null;
    const pv = proposerView(action.returnAddress);
    const model = govCardModel(action, {
      expiryUnixMs,
      now: Date.now(),
      proposerName: pv.kind === 'known' ? pv.name : null,
    });
    return renderOgCard(assets, request.url, (logo) => govCardHtml(model, logo));
  }

  // Plain discussion thread: author identity, opening-post excerpt, reply count.
  const [author, openingPostHtml] = await Promise.all([
    loadAuthorIdentity(db, topic.author_id),
    getOpeningPostBody(db, topic.id),
  ]);
  const avatarDataUrl = author.isSystem
    ? null
    : await loadAvatar(env.AVATARS as R2Bucket | undefined, author.identiconSeed ?? topic.author_id, author.imageHash);
  const model = discussionCardModel(
    { title: topic.title, categorySlug: topic.category_slug, postCount: topic.post_count, openingPostHtml },
    { authorName: author.isSystem ? null : author.displayName, avatarDataUrl },
  );
  return renderOgCard(assets, request.url, (logo) => discussionCardHtml(model, logo));
};
