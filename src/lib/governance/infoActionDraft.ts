// Draft persistence for the "/ga/new" InfoAction submission form
// (SubmitInfoAction.tsx), so a long title/motivation/rationale is not lost to
// a wallet error, laptop sleep, or an accidental tab close. Mirrors the
// draft-storage conventions from voteFlowClient.ts (dreptalk:*-draft: key
// prefix, try/catch-wrapped storage calls that are best-effort and never
// fatal), but takes the storage as an injected parameter instead of reaching
// for window.localStorage directly, so this module is unit-testable without
// jsdom: the test uses an in-memory fake, and the island passes
// window.localStorage.
//
// Kept leaf-clean on purpose: no import from cip108Canonical.ts or
// infoActionMetadata.ts (the jsonld/URDNA2015 canonicalization engine), so
// pulling this module into the island can never drag that engine into the
// client bundle. infoActionLimits.ts is fine to import if ever needed since
// it is equally leaf-clean.

/** The full set of form fields worth restoring; never wallet/address/signature/deposit/tx data. */
export interface InfoActionDraft {
  title: string;
  abstract: string;
  motivation: string;
  rationale: string;
  signAsAuthor: boolean;
  authorName: string;
  references: { label: string; uri: string }[];
}

/** Per-network draft key, so a preprod draft never collides with (a future) mainnet one. */
export function infoActionDraftKey(network: string): string {
  return `dreptalk:ga-new-draft:${network}`;
}

/** True for a plain, non-array JSON object (what JSON.parse of `{...}` produces). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored reference row coerced to `{ label, uri }` strings, or null when malformed. */
function coerceReferenceRow(raw: unknown): { label: string; uri: string } | null {
  if (!isPlainObject(raw)) return null;
  const { label, uri } = raw;
  if (typeof label !== 'string' || typeof uri !== 'string') return null;
  return { label, uri };
}

/**
 * Parses a stored draft; defensively coerces every field to a safe default
 * and drops malformed reference rows rather than rejecting the whole draft.
 * Returns null for a missing key, invalid JSON, or a non-object value (e.g. a
 * JSON array or primitive). Never throws, including when storage.getItem
 * itself throws (a blocked or disabled store).
 */
export function loadInfoActionDraft(storage: Pick<Storage, 'getItem'>, key: string): InfoActionDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const referencesRaw = parsed.references;
  const references = Array.isArray(referencesRaw)
    ? referencesRaw.map(coerceReferenceRow).filter((r): r is { label: string; uri: string } => r !== null)
    : [];

  return {
    title: typeof parsed.title === 'string' ? parsed.title : '',
    abstract: typeof parsed.abstract === 'string' ? parsed.abstract : '',
    motivation: typeof parsed.motivation === 'string' ? parsed.motivation : '',
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    signAsAuthor: parsed.signAsAuthor === true,
    authorName: typeof parsed.authorName === 'string' ? parsed.authorName : '',
    references,
  };
}

/** Stores the draft as JSON. Best-effort: storage can be full or blocked, so this never throws. */
export function saveInfoActionDraft(storage: Pick<Storage, 'setItem'>, key: string, draft: InfoActionDraft): void {
  try {
    storage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage can be full or blocked; drafting is best-effort.
  }
}

/** Removes a stored draft. Best-effort: never throws. */
export function clearInfoActionDraft(storage: Pick<Storage, 'removeItem'>, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be blocked; clearing is best-effort.
  }
}
