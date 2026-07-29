// Pure, safe parsing of a delegation_changed notification payload. Used by both
// the pre-batch drep-id collection loop and the row-building branch in
// notifications.astro so the two sites can't drift out of sync (they used to:
// one guarded a syntax error only, the other additionally used optional
// chaining and happened to be safe by accident).
import type { DelegationState } from './resolve.js';

export interface DelegationChangePayload {
  from: DelegationState | null;
  to: DelegationState;
}

const TYPES = new Set(['drep', 'abstain', 'no_confidence', 'none']);

function isDelegationState(v: unknown): v is DelegationState {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  if (typeof t !== 'string' || !TYPES.has(t)) return false;
  if (t === 'drep') return typeof (v as { drepId?: unknown }).drepId === 'string';
  return true;
}

/**
 * Parses a delegation_changed notification payload, returning null for anything
 * malformed (invalid JSON, wrong shape, missing/invalid `to`). Never throws, so
 * a bad row is dropped rather than crashing the inbox render. `from` is optional
 * (null allowed: the baseline had no prior state to compare).
 */
export function parseDelegationChangePayload(payload: string | null): DelegationChangePayload | null {
  if (!payload) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const to = (parsed as { to?: unknown }).to;
  if (!isDelegationState(to)) return null;
  const from = (parsed as { from?: unknown }).from;
  return { from: isDelegationState(from) ? from : null, to };
}
