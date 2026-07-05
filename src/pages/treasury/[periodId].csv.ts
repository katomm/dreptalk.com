// GET /treasury/:periodId.csv
//
// CSV export of the enacted treasury withdrawals within an NCL period, for
// offline analysis. `periodId` is the curated NclPeriod slug (config/ncl-periods).
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { loadTreasuryOverview } from '@/lib/treasury/overview.js';

export const prerender = false;

/** Wrap a CSV field in double quotes if it may contain a comma, quote, or newline. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export const GET: APIRoute = async ({ params, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const data = db ? await loadTreasuryOverview(db) : null;
  const card = data?.periods.find((c) => c.period.id === params.periodId);
  if (!db || !card) return new Response('Not found', { status: 404 });

  const header = 'Epoch,Withdrawal,Amount (lovelace),Amount (ADA)';
  const rows = card.windowWithdrawals.map((w) =>
    [
      String(w.enactedEpoch),
      csvField(w.title),
      w.lovelace.toString(),
      (Number(w.lovelace) / 1e6).toString(),
    ].join(','),
  );
  const csv = [header, ...rows].join('\r\n');

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ncl-${params.periodId}-withdrawals.csv"`,
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
    },
  });
};
