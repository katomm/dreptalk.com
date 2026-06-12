// POST /api/drep/profile
//
// Optimistic profile write: after a logged-in DRep submits an update_drep tx,
// the settings island calls this to show the new metadata immediately instead
// of waiting for the next gov-sync run. Session-gated and scoped to the
// caller's own row; see drepProfileApply.ts for the trust model.

import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { getUserById } from '@/lib/db/users';
import { HEX_HASH_256_RE } from '@/lib/crypto/hex';
import { applyDrepProfile } from '@/lib/governance/drepProfileApply';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user) {
    return jsonResponse({ ok: false, applied: false }, 401);
  }

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) {
    return jsonResponse({ ok: false, applied: false }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, applied: false }, 400);
  }

  const hash = (body as { hash?: unknown } | null)?.hash;
  if (typeof hash !== 'string' || !HEX_HASH_256_RE.test(hash)) {
    return jsonResponse({ ok: false, applied: false }, 400);
  }

  // Resolve the session user's drep_id; a non-DRep session simply applies
  // nothing (the handler returns applied:false).
  const user = locals.user ? await getUserById(db, locals.user.id) : null;

  const result = await applyDrepProfile({
    db,
    drepId: user?.drep_id ?? null,
    hash,
    origin: new URL(request.url).origin,
    now: Date.now(),
  });
  return jsonResponse(result.json, result.status);
};
