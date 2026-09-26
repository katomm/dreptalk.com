// Claim rules for a DRep changing its drep.link handle. Changes are deliberately
// rare: 90 days between own changes, and no new change while an earlier handle
// still redirects (taking that one back is allowed).
import { COOLDOWN_SEC, validateHandle } from './handle.js';
import type { HandleRow } from '../db/drepHandles.js';

export type ClaimError =
  | 'shape' | 'length' | 'id_namespace' | 'reserved' | 'unchanged' | 'cooldown' | 'previous_pending';

/** When the DRep may change again, or null when its current handle starts no cooldown. */
export function cooldownUntil(primary: HandleRow | null): number | null {
  if (!primary || (primary.source !== 'claim' && primary.source !== 'manual')) return null;
  return primary.createdAt + COOLDOWN_SEC;
}

/**
 * When the DRep may pick a NEW handle: after the cooldown and once its previous
 * handle has expired. Switching back to that previous handle is possible from
 * the cooldown end on. With a 90-day cooldown and 180-day grace, a new name is
 * possible 180 days after a change.
 */
export function nextNewHandleAt(cooldownEnd: number | null, previousUntil: number | null): number | null {
  if (cooldownEnd === null) return previousUntil;
  if (previousUntil === null) return cooldownEnd;
  return Math.max(cooldownEnd, previousUntil);
}

export function checkClaimPolicy(a: {
  handle: string;
  drepId: string;
  rows: HandleRow[];
  now: number;
}): { ok: true } | { ok: false; error: ClaimError; until?: number } {
  const valid = validateHandle(a.handle, a.drepId);
  if (!valid.ok) return { ok: false, error: valid.reason };
  const primary = a.rows.find((r) => r.isPrimary) ?? null;
  if (primary?.handle === a.handle) return { ok: false, error: 'unchanged' };
  const until = cooldownUntil(primary);
  if (until !== null && a.now < until) return { ok: false, error: 'cooldown', until };
  const previous = a.rows.find((r) => !r.isPrimary && r.handle !== a.handle);
  if (previous) return { ok: false, error: 'previous_pending', until: previous.releasedAt ?? undefined };
  return { ok: true };
}
