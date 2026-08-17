// Pure, safe parsing of the delegator DRep-event notification payloads
// (delegator_drep_voted / delegator_drep_re_voted / delegator_drep_status_changed).
// Mirrors parseDelegationChangePayload's shape-validating, never-throws pattern
// so a malformed row is dropped at render time rather than crashing the inbox.
// Vote events (Task 3, src/lib/db/drepVotes.ts) write { sourceTime, gaId, title, vote };
// status events (Task 4, src/lib/db/dreps.ts) write
// { sourceTime, drepId, from: {effective,status}, to: {effective,status} }.
// The two shapes never both apply to the same row, so this parser dispatches on
// which discriminating field (gaId vs drepId) is present.

export interface DrepEventState {
  effective: string;
  status: string;
}

export interface DrepEventPayload {
  sourceTime: number;
  drepId?: string;
  gaId?: string;
  title?: string;
  /** The cast choice (Yes/No/Abstain); absent on rows written before it was recorded. */
  vote?: string;
  from?: DrepEventState;
  to?: DrepEventState;
}

function isDrepEventState(v: unknown): v is DrepEventState {
  if (!v || typeof v !== 'object') return false;
  const effective = (v as { effective?: unknown }).effective;
  const status = (v as { status?: unknown }).status;
  return typeof effective === 'string' && typeof status === 'string';
}

/**
 * Parses a delegator DRep-event notification payload, returning null for
 * anything malformed (invalid JSON, wrong shape, missing required fields).
 * Never throws, so a bad row is dropped rather than crashing the inbox render.
 */
export function parseDrepEventPayload(payload: string | null): DrepEventPayload | null {
  if (!payload) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  const sourceTime = (parsed as { sourceTime?: unknown }).sourceTime;
  if (typeof sourceTime !== 'number') return null;

  const gaId = (parsed as { gaId?: unknown }).gaId;
  if (typeof gaId === 'string') {
    const title = (parsed as { title?: unknown }).title;
    const vote = (parsed as { vote?: unknown }).vote;
    return {
      sourceTime,
      gaId,
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof vote === 'string' && vote !== '' ? { vote } : {}),
    };
  }

  const drepId = (parsed as { drepId?: unknown }).drepId;
  if (typeof drepId === 'string') {
    const from = (parsed as { from?: unknown }).from;
    const to = (parsed as { to?: unknown }).to;
    if (!isDrepEventState(from) || !isDrepEventState(to)) return null;
    return { sourceTime, drepId, from, to };
  }

  return null;
}
