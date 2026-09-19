// Draft persistence for the "/ga/new" governance-action submission form
// (SubmitGovAction.tsx), so a long title/motivation/rationale is not lost to
// a wallet error, laptop sleep, or an accidental tab close. Mirrors the
// draft-storage conventions from voteFlowClient.ts (dreptalk:*-draft: key
// prefix, try/catch-wrapped storage calls that are best-effort and never
// fatal), but takes the storage as an injected parameter instead of reaching
// for window.localStorage directly, so this module is unit-testable without
// jsdom: the test uses an in-memory fake, and the island passes
// window.localStorage.
//
// v2 format: the CIP-108 metadata fields (unchanged from the v1
// InfoActionDraft this module replaces) plus a `type` selecting which form
// panel is active and a `panels` bag holding each panel's own state, keyed by
// type. Panel state stays `unknown` at this layer: each panel validates its
// own shape once it exists (a later task), this module only guarantees each
// panel value is a plain JSON object and drops anything else. A v1 draft (no
// `v` field, the shape this module used to store) loads as a v2 InfoAction
// draft with empty panels, so an existing draft in a user's browser is never
// lost by this upgrade.
//
// Kept leaf-clean on purpose: no import from cip108Canonical.ts or
// infoActionMetadata.ts (the jsonld/URDNA2015 canonicalization engine), so
// pulling this module into the island can never drag that engine into the
// client bundle. infoActionLimits.ts is fine to import if ever needed since
// it is equally leaf-clean.
import { GOV_ACTION_FORM_TYPES, type GovActionFormType } from './prevAction.js';

export type { GovActionFormType };

/** The full set of form fields worth restoring, never wallet/address/signature/deposit/tx data. */
export interface GovActionDraft {
  v: 2;
  type: GovActionFormType;
  title: string;
  abstract: string;
  motivation: string;
  rationale: string;
  signAsAuthor: boolean;
  authorName: string;
  references: { label: string; uri: string }[];
  /** Raw, unnormalised CIP-179 survey reference as typed. Empty when unset. */
  surveyRef: string;
  /** Per-type panel state, keyed by every form type except InfoAction (which has no panel). */
  panels: Partial<Record<Exclude<GovActionFormType, 'InfoAction'>, unknown>>;
}

function isFormType(value: unknown): value is GovActionFormType {
  return typeof value === 'string' && (GOV_ACTION_FORM_TYPES as readonly string[]).includes(value);
}

/** Per-network draft key, so a preprod draft never collides with (a future) mainnet one. */
export function govActionDraftKey(network: string): string {
  return `dreptalk:ga-new-draft:${network}`;
}

/** True for a plain, non-array JSON object (what JSON.parse of `{...}` produces). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerces an unknown to a string, defaulting to '' for any non-string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A stored reference row coerced to `{ label, uri }` strings, or null when malformed. */
function coerceReferenceRow(raw: unknown): { label: string; uri: string } | null {
  if (!isPlainObject(raw)) return null;
  const { label, uri } = raw;
  if (typeof label !== 'string' || typeof uri !== 'string') return null;
  return { label, uri };
}

/**
 * Coerces a stored `panels` value to the v2 shape: a plain object whose
 * per-type entries are themselves kept only when they are plain objects.
 * Anything else (a non-object panels field, or a non-object per-type value)
 * is dropped rather than failing the whole draft.
 */
function coercePanels(raw: unknown): GovActionDraft['panels'] {
  if (!isPlainObject(raw)) return {};
  const panels: Record<string, unknown> = {};
  for (const [type, value] of Object.entries(raw)) {
    if (type === 'InfoAction') continue;
    if (!isFormType(type)) continue;
    if (!isPlainObject(value)) continue;
    panels[type] = value;
  }
  return panels;
}

/**
 * Parses a stored draft, defensively coerces every field to a safe default
 * and drops malformed reference rows or panel state rather than rejecting
 * the whole draft. Returns null for a missing key, invalid JSON, or a
 * non-object value (e.g. a JSON array or primitive). A stored v1 draft (no
 * `v` field) upgrades to v2 as an InfoAction draft with empty panels. An
 * unknown `type` string falls back to InfoAction. Never throws, including
 * when storage.getItem itself throws (a blocked or disabled store).
 */
export function loadGovActionDraft(storage: Pick<Storage, 'getItem'>, key: string): GovActionDraft | null {
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
    v: 2,
    type: isFormType(parsed.type) ? parsed.type : 'InfoAction',
    title: str(parsed.title),
    abstract: str(parsed.abstract),
    motivation: str(parsed.motivation),
    rationale: str(parsed.rationale),
    signAsAuthor: parsed.signAsAuthor === true,
    authorName: str(parsed.authorName),
    references,
    // Drafts saved before the survey-link field existed simply have none.
    surveyRef: str(parsed.surveyRef),
    panels: coercePanels(parsed.panels),
  };
}

/** Stores the draft as JSON. Best-effort: storage can be full or blocked, so this never throws. */
export function saveGovActionDraft(storage: Pick<Storage, 'setItem'>, key: string, draft: GovActionDraft): void {
  try {
    storage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage can be full or blocked, drafting is best-effort.
  }
}

/** Removes a stored draft. Best-effort: never throws. */
export function clearGovActionDraft(storage: Pick<Storage, 'removeItem'>, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be blocked, clearing is best-effort.
  }
}
