// GET /og/treasury/:periodId.png
//
// Dynamic Open Graph card for a Net Change Limit treasury period, rendered on
// demand and cached. `periodId` is the curated NclPeriod slug (config/ncl-periods).
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { getEnactedTreasuryWithdrawals } from '@/lib/db/treasury.js';
import { nclStatusFor } from '@/lib/governance/ncl.js';
import { treasuryCardModel } from '@/lib/og/model.js';
import { renderOgCard } from '@/lib/og/render.js';
import { treasuryCardHtml } from '@/lib/og/templates.js';
import { getNclPeriod } from '../../../../config/ncl-periods.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const period = params.periodId ? getNclPeriod(params.periodId) : undefined;
  if (!db || !period) return new Response('Not found', { status: 404 });

  const withdrawals = await getEnactedTreasuryWithdrawals(db);
  const status = nclStatusFor(period, withdrawals);
  const model = treasuryCardModel(status);

  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, () => treasuryCardHtml(model));
};
