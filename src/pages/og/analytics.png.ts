// GET /og/analytics.png
//
// Dynamic Open Graph card for the governance analytics hub: total delegated
// voting power drawn epoch by epoch over the contiguous part of the series,
// the powered-DRep count, recent-voting participation, the smallest group
// holding half of the power and the share of circulating ada delegated,
// rendered on demand and cached. Reads the same governance_epoch_stats rows
// the page itself reads, so the card and the page never disagree, and clips to
// the gapless head of the series like the page's charts do while a backfill
// is still filling older epochs.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { renderOgCard } from '@/lib/og/render.js';
import { analyticsCardModel } from '@/lib/og/model.js';
import { analyticsCardHtml } from '@/lib/og/templates.js';
import { listEpochStats } from '@/lib/db/governanceEpochStats.js';
import { getProtocolParams } from '@/lib/db/protocolParams.js';
import { contiguousPrefix } from '@/lib/analytics/hubView.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('Not found', { status: 404 });

  const [stats, params] = await Promise.all([listEpochStats(db), getProtocolParams(db)]);
  const current = stats.length > 0 ? stats[stats.length - 1] : null;
  if (!current) return new Response('Not found', { status: 404 });
  const series = contiguousPrefix(stats);

  const model = analyticsCardModel({
    epoch: current.epoch,
    powered: current.poweredDrepCount,
    recentlyVoting: current.recentlyVotingDrepCount,
    totalPowerLovelace: current.totalDrepPower,
    abstainLovelace: current.abstainPower,
    halfCount: current.minCoalition50,
    circulationLovelace: params?.circulationLovelace ?? null,
    series: series.map((r) => ({ epoch: r.epoch, totalDrepPower: r.totalDrepPower })),
  });

  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, () => analyticsCardHtml(model));
};
