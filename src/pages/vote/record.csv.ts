// GET /vote/record.csv
//
// CSV export of the signed-in DRep's voting record, for offline analysis or
// archiving. Gated exactly like /vote: the drep_id comes from the session user,
// never the client. A logged-out or non-DRep caller is redirected to /login.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { getSelfDrepId } from '@/lib/db/users';
import { getDrepByIdOrSlug } from '@/lib/db/dreps';
import { getDrepVotingHistory } from '@/lib/db/drepVotes';
import { buildVoteRecordCsv } from '@/lib/governance/voteRecordCsv';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request, redirect }) => {
  const user = (locals as App.Locals).user;
  if (!user?.roles.includes('drep')) {
    return redirect('/login/');
  }

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const drepId = db ? await getSelfDrepId(db, user) : null;
  if (!db || !drepId) {
    // The DRep id has not synced yet; nothing to export.
    return redirect('/vote/');
  }

  // Match the dashboard: full history (realistically ~150 rows) newest first,
  // plus the DRep record to build the shareable rationale-page base.
  const [rows, drep] = await Promise.all([
    // The CSV links to the rationale page when one exists; it never renders the
    // body, so fetch presence only, not the full HTML, across all 500 rows.
    getDrepVotingHistory(db, drepId, { limit: 500, rationalePresenceOnly: true }),
    getDrepByIdOrSlug(db, drepId),
  ]);
  const voteShareBase = drep ? `/dreps/${drep.slug ?? drep.drepId}/vote/` : null;

  const csv = buildVoteRecordCsv(rows, { origin: new URL(request.url).origin, voteShareBase });

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="dreptalk-voting-record.csv"',
      // Private: this is the viewer's own record, not a shared resource.
      'Cache-Control': 'private, no-store',
    },
  });
};
