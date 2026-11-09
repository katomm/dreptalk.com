// GET /api/groups/actions/held
// The wallet outputs the session's own open group actions spend, so the builder of a new action
// leaves them out. Only the session's own rows are read out, never another user's.
import type { APIRoute } from 'astro';
import { currentNetwork, jsonResponse, runtimeEnv } from '@/lib/api/response';
import { inputsHeldBy, openActionInputsOf } from '@/lib/groups/actionStore';
import { drepGroupsAvailable } from '@/lib/groups/gate';

export const prerender = false;

const NO_STORE = { 'cache-control': 'no-store' };

export const GET: APIRoute = async ({ locals }) => {
  if (!drepGroupsAvailable(currentNetwork().network)) return jsonResponse({ error: 'not found' }, 404, NO_STORE);
  const user = (locals as App.Locals).user;
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401, NO_STORE);
  const db = runtimeEnv(locals as App.Locals).DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'service unavailable' }, 503, NO_STORE);
  return jsonResponse({ heldInputs: inputsHeldBy(await openActionInputsOf(db, user.id), user.id) }, 200, NO_STORE);
};
