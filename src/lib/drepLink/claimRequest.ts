// Request logic behind POST /api/drep/handle, separate from the Astro route so
// the workers tests can drive it with a real D1.
import { normalizeHandleInput } from './handle.js';
import { checkClaimPolicy } from './claim.js';
import { isSeeded, listDrepHandles, writeClaim } from '../db/drepHandles.js';
import { getSelfDrepId } from '../db/users.js';
import { getDrepById } from '../db/dreps.js';

export interface ClaimResponse {
  status: number;
  body: Record<string, unknown>;
}

/** `now` is unix seconds. */
export async function claimHandleRequest(a: {
  db: D1Database;
  user: App.Locals['user'];
  body: unknown;
  now: number;
}): Promise<ClaimResponse> {
  const { db, user, body, now } = a;
  if (!user) return { status: 401, body: { ok: false, error: 'unauthorized' } };
  // Co-proposer grant sessions act for someone else and never count as the DRep.
  if (user.grantId) return { status: 403, body: { ok: false, error: 'forbidden' } };
  const drepId = await getSelfDrepId(db, user);
  if (!drepId) return { status: 403, body: { ok: false, error: 'forbidden' } };
  if (!(await isSeeded(db))) return { status: 503, body: { ok: false, error: 'not_open' } };
  const drep = await getDrepById(db, drepId);
  if (!drep) return { status: 409, body: { ok: false, error: 'not_synced' } };
  if (drep.status !== 'registered') return { status: 403, body: { ok: false, error: 'not_registered' } };

  const b = (body ?? null) as { handle?: unknown; expectedCurrent?: unknown } | null;
  if (!b || typeof b.handle !== 'string') return { status: 400, body: { ok: false, error: 'bad_request' } };
  const expected = b.expectedCurrent ?? null;
  if (expected !== null && typeof expected !== 'string') return { status: 400, body: { ok: false, error: 'bad_request' } };

  const handle = normalizeHandleInput(b.handle);
  const rows = await listDrepHandles(db, drepId, now);
  // The form's view must match what D1 says now. The write then uses the
  // server-read primary, so a forged expectedCurrent cannot skip the policy.
  const current = rows.find((r) => r.isPrimary)?.handle ?? null;
  const policy = checkClaimPolicy({ handle, drepId, rows, now });
  if (!policy.ok) return { status: 409, body: { ok: false, error: policy.error, until: policy.until ?? null } };
  if (expected !== current) return { status: 409, body: { ok: false, error: 'stale' } };

  const outcome = await writeClaim(db, { drepId, handle, expectedCurrent: current, now });
  if (!outcome.ok) return { status: 409, body: { ok: false, error: outcome.error } };
  return { status: 200, body: { ok: true, handle } };
}
