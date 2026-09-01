// GET /og/analytics.png
//
// Dynamic Open Graph card for the governance analytics hub: the powered-DRep
// count, total delegated voting power, recent-voting participation and (when
// it holds power) the always-abstain default option for the current epoch,
// rendered on demand and cached. Reads the same governance_epoch_stats row
// the page itself reads, so the card and the page never disagree.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { renderOgCard } from '@/lib/og/render.js';
import { analyticsCardModel } from '@/lib/og/model.js';
import { analyticsCardHtml } from '@/lib/og/templates.js';
import { listEpochStats } from '@/lib/db/governanceEpochStats.js';
import { formatAda } from '@/lib/forum/view.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('Not found', { status: 404 });

  const stats = await listEpochStats(db);
  const current = stats.length > 0 ? stats[stats.length - 1] : null;
  if (!current) return new Response('Not found', { status: 404 });

  const model = analyticsCardModel({
    epoch: current.epoch,
    powered: current.poweredDrepCount,
    recentlyVoting: current.recentlyVotingDrepCount,
    totalPowerLabel: formatAda(current.totalDrepPower),
    abstainLabel: current.abstainPower != null ? formatAda(current.abstainPower) : null,
  });

  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, () => analyticsCardHtml(model));
};
