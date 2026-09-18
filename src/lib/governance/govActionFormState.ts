// Pure state for the /ga/new submit form: the chosen action type, the CIP-108
// metadata fields, one state bag per type panel, and the live ledger context
// fetched for the chosen type. Everything wallet-related (the enabled CIP-30
// api, the connect/submit phase) stays in the island, so this module is a
// plain reducer that can be unit-tested without React or a DOM.
//
// Out-of-order guard: every context fetch carries a request id, and a loaded
// or failed response is ignored unless its id is still the latest one. A fast
// type switch therefore cannot land the previous type's chain data on the new
// type's panel.
//
// Leaf-clean like the other modules the island pulls in: the only imports are
// types, so nothing from the canonicalisation engine can reach the client
// bundle through here.
import type { GovActionFormType, PrevActionRef } from './prevAction.js';
import type { ProtocolVersion } from './hardForkVersion.js';
import type { GovActionDraft } from './govActionDraft.js';
import type { ActionContextResponse } from './actionContextHandler.js';

/** The four types that need a previous action, i.e. everything with a panel. */
export type ChainedFormType = Exclude<GovActionFormType, 'InfoAction'>;

/** The CIP-108 fields, shared by every action type and kept across a type switch. */
export interface MetadataState {
  title: string;
  abstract: string;
  motivation: string;
  rationale: string;
  signAsAuthor: boolean;
  authorName: string;
  references: { label: string; uri: string }[];
  surveyRef: string;
}

// Panel state note: `prev` is the user's explicit choice from the Advanced
// disclosure. null means "the chain root as the context reports it", which is
// what the field shows by default, so a root that moves while the page is
// open is still resolved through effectivePrev() against the context that was
// actually displayed.

export interface NoConfidencePanelState {
  prev: PrevActionRef | null;
}

export interface HardForkPanelState {
  prev: PrevActionRef | null;
  version: ProtocolVersion | null;
}

export interface NewConstitutionPanelState {
  prev: PrevActionRef | null;
  /** The Markdown constitution body, exactly as typed. */
  text: string;
  /** Optional guardrails script hash, 56 hex chars. Empty means no script. */
  scriptHashHex: string;
}

/** A credential input row: the raw text plus the key/script choice hex input needs. */
export interface CommitteeCredentialRow {
  input: string;
  hexKind: 'key' | 'script';
}

/** An add row: a credential plus its term expiry, kept as typed text so the field can be empty. */
export interface CommitteeAddRow extends CommitteeCredentialRow {
  expiryEpoch: string;
}

export interface UpdateCommitteePanelState {
  prev: PrevActionRef | null;
  /** Cold hex of the sitting members ticked for removal (enacted mode). */
  removeHex: string[];
  /** Free credential rows for removal, used when chaining onto an open proposal. */
  removeFree: CommitteeCredentialRow[];
  add: CommitteeAddRow[];
  /** Kept as typed text so the fields can be empty, null until prefilled or typed. */
  quorum: { numerator: string; denominator: string } | null;
}

export interface PanelStates {
  NoConfidence: NoConfidencePanelState;
  HardForkInitiation: HardForkPanelState;
  NewConstitution: NewConstitutionPanelState;
  UpdateCommittee: UpdateCommitteePanelState;
}

export type ContextState =
  | { status: 'idle'; requestId: number; data: null }
  // `data` survives a refetch so the panel keeps rendering while the
  // submit-time freshness check is in flight.
  | { status: 'loading'; requestId: number; data: ActionContextResponse | null }
  | { status: 'ready'; requestId: number; data: ActionContextResponse }
  | { status: 'error'; requestId: number; data: null };

export interface GovActionFormState {
  type: GovActionFormType;
  metadata: MetadataState;
  panels: PanelStates;
  context: ContextState;
}

type SetPanelAction = {
  [K in ChainedFormType]: { kind: 'setPanel'; type: K; state: PanelStates[K] };
}[ChainedFormType];

export type GovActionFormAction =
  | { kind: 'setType'; type: GovActionFormType }
  | { kind: 'setMetadata'; patch: Partial<MetadataState> }
  | SetPanelAction
  | { kind: 'contextRequested'; requestId: number }
  | { kind: 'contextLoaded'; requestId: number; data: ActionContextResponse }
  | { kind: 'contextFailed'; requestId: number }
  | { kind: 'restoreDraft'; draft: GovActionDraft };

export function emptyMetadataState(): MetadataState {
  return {
    title: '',
    abstract: '',
    motivation: '',
    rationale: '',
    signAsAuthor: false,
    authorName: '',
    references: [],
    surveyRef: '',
  };
}

export function emptyPanelStates(): PanelStates {
  return {
    NoConfidence: { prev: null },
    HardForkInitiation: { prev: null, version: null },
    NewConstitution: { prev: null, text: '', scriptHashHex: '' },
    UpdateCommittee: { prev: null, removeHex: [], removeFree: [], add: [], quorum: null },
  };
}

export function initialGovActionFormState(): GovActionFormState {
  return {
    type: 'InfoAction',
    metadata: emptyMetadataState(),
    panels: emptyPanelStates(),
    context: { status: 'idle', requestId: 0, data: null },
  };
}

// ---------------------------------------------------------------------------
// Draft coercion: stored panel state is `unknown` at the draft layer, so every
// field is checked here and anything malformed falls back to its default.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function coercePrev(value: unknown): PrevActionRef | null {
  if (!isPlainObject(value)) return null;
  const { txHashHex, index } = value;
  if (typeof txHashHex !== 'string' || !Number.isInteger(index)) return null;
  return { txHashHex, index: index as number };
}

function coerceVersion(value: unknown): ProtocolVersion | null {
  if (!isPlainObject(value)) return null;
  const { major, minor } = value;
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { major: major as number, minor: minor as number };
}

function coerceHexKind(value: unknown): 'key' | 'script' {
  return value === 'script' ? 'script' : 'key';
}

function coerceNoConfidencePanel(raw: unknown): NoConfidencePanelState {
  if (!isPlainObject(raw)) return { prev: null };
  return { prev: coercePrev(raw.prev) };
}

function coerceHardForkPanel(raw: unknown): HardForkPanelState {
  if (!isPlainObject(raw)) return { prev: null, version: null };
  return { prev: coercePrev(raw.prev), version: coerceVersion(raw.version) };
}

function coerceNewConstitutionPanel(raw: unknown): NewConstitutionPanelState {
  if (!isPlainObject(raw)) return { prev: null, text: '', scriptHashHex: '' };
  return { prev: coercePrev(raw.prev), text: str(raw.text), scriptHashHex: str(raw.scriptHashHex) };
}

function coerceUpdateCommitteePanel(raw: unknown): UpdateCommitteePanelState {
  const empty: UpdateCommitteePanelState = {
    prev: null,
    removeHex: [],
    removeFree: [],
    add: [],
    quorum: null,
  };
  if (!isPlainObject(raw)) return empty;
  const removeHex = Array.isArray(raw.removeHex)
    ? raw.removeHex.filter((h): h is string => typeof h === 'string')
    : [];
  const removeFree = Array.isArray(raw.removeFree)
    ? raw.removeFree
        .filter(isPlainObject)
        .map(r => ({ input: str(r.input), hexKind: coerceHexKind(r.hexKind) }))
    : [];
  const add = Array.isArray(raw.add)
    ? raw.add
        .filter(isPlainObject)
        .map(r => ({ input: str(r.input), hexKind: coerceHexKind(r.hexKind), expiryEpoch: str(r.expiryEpoch) }))
    : [];
  const quorumRaw = raw.quorum;
  const quorum = isPlainObject(quorumRaw)
    ? { numerator: str(quorumRaw.numerator), denominator: str(quorumRaw.denominator) }
    : null;
  return { prev: coercePrev(raw.prev), removeHex, removeFree, add, quorum };
}

/** Rebuilds every panel from a stored draft, defaulting each one that is missing or malformed. */
export function panelStatesFromDraft(draft: GovActionDraft): PanelStates {
  return {
    NoConfidence: coerceNoConfidencePanel(draft.panels.NoConfidence),
    HardForkInitiation: coerceHardForkPanel(draft.panels.HardForkInitiation),
    NewConstitution: coerceNewConstitutionPanel(draft.panels.NewConstitution),
    UpdateCommittee: coerceUpdateCommitteePanel(draft.panels.UpdateCommittee),
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function govActionFormReducer(
  state: GovActionFormState,
  action: GovActionFormAction,
): GovActionFormState {
  switch (action.kind) {
    case 'setType': {
      if (action.type === state.type) return state;
      // The context belongs to the type it was fetched for, so it is dropped
      // while every panel's own state is kept for a switch back.
      return {
        ...state,
        type: action.type,
        context: { status: 'idle', requestId: state.context.requestId, data: null },
      };
    }

    case 'setMetadata':
      return { ...state, metadata: { ...state.metadata, ...action.patch } };

    case 'setPanel':
      return { ...state, panels: { ...state.panels, [action.type]: action.state } };

    case 'contextRequested':
      return {
        ...state,
        context: { status: 'loading', requestId: action.requestId, data: state.context.data },
      };

    case 'contextLoaded':
      if (action.requestId !== state.context.requestId) return state;
      return { ...state, context: { status: 'ready', requestId: action.requestId, data: action.data } };

    case 'contextFailed':
      if (action.requestId !== state.context.requestId) return state;
      return { ...state, context: { status: 'error', requestId: action.requestId, data: null } };

    case 'restoreDraft':
      return {
        ...state,
        type: action.draft.type,
        metadata: {
          title: action.draft.title,
          abstract: action.draft.abstract,
          motivation: action.draft.motivation,
          rationale: action.draft.rationale,
          signAsAuthor: action.draft.signAsAuthor,
          authorName: action.draft.authorName,
          references: action.draft.references,
          surveyRef: action.draft.surveyRef,
        },
        panels: panelStatesFromDraft(action.draft),
      };
  }
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/**
 * Resolves the previous action a panel will actually propose against: the
 * user's explicit pick, or the chain root of the context that was displayed
 * when nothing was picked. Resolving against the displayed context (not the
 * submit-time refetch) is what lets the freshness check notice a root that
 * moved in the meantime.
 */
export function effectivePrev(
  chosen: PrevActionRef | null,
  context: ActionContextResponse | null,
): PrevActionRef | null {
  if (chosen) return chosen;
  const root = context?.prev?.lastEnacted;
  if (!root) return null;
  return { txHashHex: root.txHash, index: root.index };
}

/** Builds the v2 draft for the current state: the type, the metadata, every panel. */
export function draftFromState(state: GovActionFormState): GovActionDraft {
  return {
    v: 2,
    type: state.type,
    ...state.metadata,
    panels: {
      NoConfidence: state.panels.NoConfidence,
      HardForkInitiation: state.panels.HardForkInitiation,
      NewConstitution: state.panels.NewConstitution,
      UpdateCommittee: state.panels.UpdateCommittee,
    },
  };
}

function panelsAreEmpty(panels: PanelStates): boolean {
  const empty = emptyPanelStates();
  return (
    panels.NoConfidence.prev === null &&
    panels.HardForkInitiation.prev === null &&
    panels.HardForkInitiation.version === null &&
    panels.NewConstitution.prev === null &&
    panels.NewConstitution.text === empty.NewConstitution.text &&
    panels.NewConstitution.scriptHashHex === empty.NewConstitution.scriptHashHex &&
    panels.UpdateCommittee.prev === null &&
    panels.UpdateCommittee.removeHex.length === 0 &&
    panels.UpdateCommittee.removeFree.length === 0 &&
    panels.UpdateCommittee.add.length === 0 &&
    panels.UpdateCommittee.quorum === null
  );
}

/**
 * True when there is nothing worth storing: no metadata text, the type still
 * on the InfoAction default, and every panel untouched. A filled panel with
 * empty metadata is therefore kept, which is the whole point of storing the
 * panels in the draft.
 */
export function isFormBlank(state: GovActionFormState): boolean {
  const m = state.metadata;
  const metadataBlank =
    !m.title.trim() &&
    !m.abstract.trim() &&
    !m.motivation.trim() &&
    !m.rationale.trim() &&
    !m.authorName.trim() &&
    m.references.length === 0 &&
    !m.surveyRef.trim();
  return metadataBlank && state.type === 'InfoAction' && panelsAreEmpty(state.panels);
}
