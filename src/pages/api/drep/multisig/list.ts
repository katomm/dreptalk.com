// GET /api/drep/multisig/list
// Returns the open (collecting, non-expired) pending multisig votes for the
// authenticated DRep member. The DRep id is derived from the session; clients
// cannot list another DRep's pending votes.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { getUserById } from '@/lib/db/users';
import { listPendingForDrep } from '@/lib/db/pendingMultisigTx';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as App.Locals).user;
  if (!user?.roles.includes('drep')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'service unavailable' }, 503);

  // Derive the DRep id from the session user record, never from a query param.
  const dbUser = await getUserById(db, user.id);
  const drepId = dbUser?.drep_id ?? null;
  if (!drepId) {
    return jsonResponse({ items: [] }, 200);
  }

  const now = Math.floor(Date.now() / 1000);
  const rows = await listPendingForDrep(db, drepId, now);

  const items: Array<{
    id: string;
    gaId: string;
    vote: string;
    createdAt: number;
    expiresAt: number;
  }> = [];

  for (const row of rows) {
    let gaId: string;
    let vote: string;
    try {
      const params = JSON.parse(row.action_params) as { gaId?: unknown; vote?: unknown };
      if (typeof params.gaId !== 'string' || typeof params.vote !== 'string') {
        // Corrupt or unexpected shape: skip this row rather than failing the list.
        continue;
      }
      gaId = params.gaId;
      vote = params.vote;
    } catch {
      // Corrupt action_params JSON: skip this row.
      continue;
    }

    items.push({
      id: row.id,
      gaId,
      vote,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  }

  return jsonResponse({ items }, 200);
};
