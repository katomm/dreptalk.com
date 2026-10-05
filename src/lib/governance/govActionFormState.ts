// Pure state for the /ga/new submit form: the chosen action type, the CIP-108
// metadata fields, one state bag per type panel, the live ledger context
// fetched for the chosen type, and the wallet step at the end of the form.
// The enabled CIP-30 api object itself stays in the island's ref (it is not
// data, it is a live IPC handle), so this module remains a plain reducer that
// can be unit-tested without React or a DOM.
//
// Out-of-order guard: every context fetch carries a request id, and a loaded
// or failed response is ignored unless its id is still the latest one. A fast
// type switch therefore cannot deliver the previous type's chain data on the new
// type's panel.
//
// Leaf-clean like the other modules the island pulls in: types plus a handful
// of pure leaf helpers, so nothing from the canonicalisation engine can reach
// the client bundle through here.
import { matchesRef } from './prevAction.js';
import type { GovActionFormType, PrevActionRef } from './prevAction.js';
import { hardForkBaseVersion, versionsThatFollow } from './hardForkVersion.js';
import type { ProtocolVersion } from './hardForkVersion.js';
import { HEX_HASH_224_RE } from '../crypto/hex.js';
import { shortenHash } from './onchain.js';
import { CONSTITUTION_DOCUMENT_MAX_BYTES, REFERENCES_MAX } from './infoActionLimits.js';
import type { GovActionDraft } from './govActionDraft.js';
import { draftSlugsFromReferences } from './draftLink.js';
import type { ActionContextResponse } from './actionContextHandler.js';
import { parseColdCredential, validateCommitteeUpdate } from './committeeUpdate.js';
import type {
  AddedMember,
  ColdCredential,
  CommitteeUpdate,
  CurrentMember,
  Quorum,
  ValidationError,
  ValidationWarning,
} from './committeeUpdate.js';

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
  /**
   * Optional guardrails script hash, 56 hex chars. null means the field was
   * never touched, so the hash of the constitution in force is used, and an
   * empty string means the user deliberately cleared it to propose a
   * constitution with no guardrails script. Derived rather than prefilled
   * into the state, so an edit to another field cannot overwrite the default.
   */
  scriptHashHex: string | null;
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
  /**
   * Kept as typed text so the fields can be empty. null means untouched, in
   * which case the quorum of the committee in force is used. Derived rather
   * than prefilled into the state, so an edit to another field cannot
   * overwrite the default.
   */
  quorum: { numerator: string; denominator: string } | null;
}

export interface PanelStates {
  NoConfidence: NoConfidencePanelState;
  HardForkInitiation: HardForkPanelState;
  NewConstitution: NewConstitutionPanelState;
  UpdateCommittee: UpdateCommitteePanelState;
}

/**
 * One change note per default-affecting field, so a field that does not move
 * on a given refetch keeps whatever note an earlier refetch gave it instead
 * of the whole set being replaced wholesale. null means "nothing to say"
 * (never moved yet, or the user has since edited the form). See
 * mergeContextChanges for how a fresh reading updates these, and
 * contextChangeLines for the island's rendering order.
 */
export interface ContextChangeNotes {
  prevAction: string | null;
  quorum: string | null;
  scriptHash: string | null;
  protocolVersion: string | null;
}

/** The shared "nothing to say yet" value, reused so an idle/error/cleared context is a cheap reference compare, not a fresh allocation. */
export const NO_CONTEXT_CHANGES: ContextChangeNotes = {
  prevAction: null,
  quorum: null,
  scriptHash: null,
  protocolVersion: null,
};

export type ContextState =
  | { status: 'idle'; requestId: number; data: null; loadedAt: null; changes: ContextChangeNotes }
  // `data` survives a refetch so the panel keeps rendering while the
  // submit-time freshness check is in flight. `changes` survives it the same
  // way, so the island keeps showing the last computed notes until the fresh
  // response replaces them (see contextLoaded).
  | {
      status: 'loading';
      requestId: number;
      data: ActionContextResponse | null;
      loadedAt: number | null;
      changes: ContextChangeNotes;
    }
  // `loadedAt` is the moment this reading arrived (ms, from the action's own
  // `now`, not read from the clock here, so a test can control it), what the
  // island's "loaded n minutes ago" line is based on.
  | { status: 'ready'; requestId: number; data: ActionContextResponse; loadedAt: number; changes: ContextChangeNotes }
  | { status: 'error'; requestId: number; data: null; loadedAt: null; changes: ContextChangeNotes };

/** The current governance action deposit, read once from /epoch_params. */
export type DepositState =
  | { status: 'loading' }
  | { status: 'ready'; lovelace: bigint }
  | { status: 'error'; message: string };

/**
 * The connected wallet's funding balance: collected from the same UTxO reader
 * the transaction builder uses, so the readiness check and the builder agree.
 */
export type WalletBalanceState =
  | { status: 'loading' }
  | {
      status: 'ready';
      lovelace: bigint;
      /**
       * Whether the reward address (where the deposit is refunded) is a
       * registered stake account. Absent when the lookup failed: the ledger
       * then has the last word, the form does not guess.
       */
      rewardRegistered?: boolean;
    }
  | { status: 'error'; message: string };

/**
 * The wallet step, which sits at the END of the form: a signed-in user drafts
 * the whole action with `none` here and only then connects. The reward address
 * is kept because the deposit refund goes there and (when signing as author)
 * the CIP-108 witness proves ownership of it.
 */
export type WalletState =
  | { status: 'none' }
  | { status: 'connecting' }
  | { status: 'connected'; rewardAddressHex: string; balance: WalletBalanceState };

export interface GovActionFormState {
  type: GovActionFormType;
  metadata: MetadataState;
  panels: PanelStates;
  context: ContextState;
  wallet: WalletState;
  /**
   * True once the user has edited anything, false again after a draft is
   * restored. Restoring is not an edit: it is the form coming back as it was.
   */
  dirty: boolean;
  /**
   * The Proposal Drafts thread slug the "Link a Proposal Draft" control is
   * tracking, or null when nothing is linked. The reference it produced
   * ({ label: title, uri: `${siteOrigin}/t/${slug}/` }) lives in
   * metadata.references like any other reference. This field only lets
   * linkDraft find and replace that one row again.
   */
  linkedDraftSlug: string | null;
  /**
   * Set when linkDraft's append-at-the-cap is refused, shown next to the
   * draft control. Cleared by the next linkDraft or unlinkDraft, not by
   * unrelated edits, since it is that control's own message.
   */
  draftLinkError: string | null;
}

type SetPanelAction = {
  [K in ChainedFormType]: { kind: 'setPanel'; type: K; state: PanelStates[K] };
}[ChainedFormType];

export type GovActionFormAction =
  | { kind: 'setType'; type: GovActionFormType }
  | {
      kind: 'setMetadata';
      patch: Partial<MetadataState>;
      /**
       * What draftSlugsFromReferences compares a reference's URL against,
       * needed only to notice a hand-edited references array walking the
       * tracked draft reference away (see the reducer's setMetadata case).
       * Optional and skipped when absent, never used to clear a tracked slug
       * on a guess: a caller that does not pass it leaves tracking as is.
       */
      siteOrigin?: string;
    }
  | SetPanelAction
  | { kind: 'contextRequested'; requestId: number }
  | {
      kind: 'contextLoaded';
      requestId: number;
      data: ActionContextResponse;
      /** The load's own clock reading (ms), carried in the action so a test can control it instead of racing Date.now(). */
      now: number;
    }
  | { kind: 'contextFailed'; requestId: number }
  | {
      kind: 'restoreDraft';
      draft: GovActionDraft;
      /** The open drafts, for deriving the tracked slug of a legacy draft (no stored linkedDraftSlug). Defaults to none. */
      openDrafts?: readonly { slug: string }[];
      /** What the matcher compares reference URLs against. Defaults to '', under which no reference ever matches. */
      siteOrigin?: string;
    }
  | { kind: 'discardDraft'; displayName: string }
  | {
      kind: 'linkDraft';
      slug: string;
      title: string;
      siteOrigin: string;
      /**
       * The slug the control is showing as chosen (see
       * effectiveLinkedDraftSlug), which is the reference this pick replaces.
       * Without it a hand-typed reference to an open draft would be shown as
       * selected and then left in place next to the new one. Optional, so a
       * caller that only ever links through the control stays valid.
       */
      selectedSlug?: string | null;
    }
  | {
      kind: 'unlinkDraft';
      siteOrigin: string;
      /** The slug the control is showing as chosen, the one "No draft linked" removes. */
      selectedSlug?: string | null;
    }
  | { kind: 'walletConnecting' }
  | { kind: 'walletConnected'; rewardAddressHex: string }
  | { kind: 'walletBalanceLoading' }
  | { kind: 'walletBalance'; lovelace: bigint; rewardRegistered?: boolean }
  | { kind: 'walletBalanceFailed'; message: string }
  | { kind: 'walletDisconnected' };

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
    NewConstitution: { prev: null, text: '', scriptHashHex: null },
    UpdateCommittee: { prev: null, removeHex: [], removeFree: [], add: [], quorum: null },
  };
}

/**
 * The metadata a fresh or discarded form starts from: signing as author is on
 * by default, with the signed-in display name prefilled. Shared by
 * initialGovActionFormState and the discardDraft action so the two can never
 * disagree about what "untouched" looks like.
 */
function defaultMetadataState(displayName: string): MetadataState {
  return { ...emptyMetadataState(), signAsAuthor: true, authorName: displayName };
}

/**
 * @param displayName The signed-in user's display name (resolved the way
 * /home/ resolves it), prefilled as the author name with signing on by
 * default. Empty when there is none to show, which keeps every existing
 * caller that omits it valid.
 */
export function initialGovActionFormState(displayName = ''): GovActionFormState {
  return {
    type: 'InfoAction',
    metadata: defaultMetadataState(displayName),
    panels: emptyPanelStates(),
    context: { status: 'idle', requestId: 0, data: null, loadedAt: null, changes: NO_CONTEXT_CHANGES },
    wallet: { status: 'none' },
    dirty: false,
    linkedDraftSlug: null,
    draftLinkError: null,
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
  if (!isPlainObject(raw)) return { prev: null, text: '', scriptHashHex: null };
  return {
    prev: coercePrev(raw.prev),
    text: str(raw.text),
    scriptHashHex: typeof raw.scriptHashHex === 'string' ? raw.scriptHashHex : null,
  };
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
// Proposal Draft link (linkDraft / unlinkDraft / restoreDraft's legacy
// derivation), all built on draftSlugsFromReferences so the exact same rule
// that gov-sync uses to read a draft link back out of the references also
// decides which reference the "Link a Proposal Draft" control is tracking.
// ---------------------------------------------------------------------------

/** The exact reference shape linkDraft writes, recognized by draftSlugsFromReferences. */
function draftReferenceUri(siteOrigin: string, slug: string): string {
  return `${siteOrigin}/t/${slug}/`;
}

/** The index of the reference row naming the given slug, or -1 when there is none. */
function referenceIndexForSlug(
  references: readonly { label: string; uri: string }[],
  slug: string | null,
  siteOrigin: string,
): number {
  if (!slug) return -1;
  return references.findIndex((r) => draftSlugsFromReferences([r], siteOrigin).includes(slug));
}

/**
 * A slugify() output shape (see forum.ts): lowercase letters, digits and
 * hyphens. A stored linkedDraftSlug that fails this is either corrupted or
 * tampered localStorage content, never a slug this app wrote, so it is
 * dropped rather than trusted as a select option's value.
 */
export const DRAFT_SLUG_RE = /^[a-z0-9-]+$/i;

/** The first reference whose thread slug is in the open drafts list, or null when none matches. */
function firstOpenDraftSlugInReferences(
  references: readonly { label: string; uri: string }[],
  openDrafts: readonly { slug: string }[],
  siteOrigin: string,
): string | null {
  const openSlugs = new Set(openDrafts.map((d) => d.slug));
  for (const ref of references) {
    const [slug] = draftSlugsFromReferences([ref], siteOrigin);
    if (slug && openSlugs.has(slug)) return slug;
  }
  return null;
}

/**
 * The draft reference the link control is acting on: the tracked slug while
 * its reference is still there, else whatever the control is showing as chosen
 * (a hand-typed or hand-edited reference to an open draft, which the control
 * never added and therefore never tracked). Only a slug that really has a
 * reference row is returned, so the caller either replaces or removes an
 * existing row, never neither.
 */
function actedOnDraftSlug(
  references: readonly { label: string; uri: string }[],
  trackedSlug: string | null,
  selectedSlug: string | null | undefined,
  siteOrigin: string,
): string | null {
  if (trackedSlug && referenceIndexForSlug(references, trackedSlug, siteOrigin) !== -1) return trackedSlug;
  if (selectedSlug && referenceIndexForSlug(references, selectedSlug, siteOrigin) !== -1) return selectedSlug;
  return null;
}

/**
 * Restores the invariant that the tracked draft's reference is the FIRST
 * reference row, moving it there and leaving every other row in its relative
 * order. A no-op when nothing is tracked, when the tracked slug has no
 * reference, or when it is already first.
 *
 * resolveDraftTopic (see draftLinks.ts) reads the FIRST Proposal Drafts
 * reference of a submitted document, and its filter only excludes a deleted
 * thread, not a closed or already-linked one. A stored draft whose references
 * put a closed draft ahead of the tracked one, or an edit that moves a row
 * above it, would otherwise submit a document linking a thread the control
 * never showed as chosen, and nothing on the client would say so: draftConflict
 * only counts references naming an open draft, which a closed one is not.
 * linkDraft writes the picked reference to the front for the same reason, this
 * keeps it there through the paths that do not go through linkDraft at all.
 */
function draftReferenceFirst(
  references: { label: string; uri: string }[],
  slug: string | null,
  siteOrigin: string,
): { label: string; uri: string }[] {
  const index = referenceIndexForSlug(references, slug, siteOrigin);
  if (index <= 0) return references;
  return [references[index], ...references.filter((_, i) => i !== index)];
}

/**
 * The tracked slug for a restored draft: the stored value when the draft
 * carries one and it is a well-formed slug (a string, or an explicit null for
 * "linked then unlinked"), or, for a draft saved before linkedDraftSlug
 * existed (the key is absent, not null), the first reference whose thread
 * slug is still in the open drafts list. A reference naming a slug that is
 * not open (a closed or foreign thread) is left alone, exactly as a manually
 * typed reference always was. A malformed stored slug (see DRAFT_SLUG_RE) is
 * dropped rather than derived around, since a corrupted explicit value is not
 * the same signal as one simply predating the field.
 */
function linkedDraftSlugFromDraft(
  draft: GovActionDraft,
  openDrafts: readonly { slug: string }[],
  siteOrigin: string,
): string | null {
  if (draft.linkedDraftSlug !== undefined) {
    const slug = draft.linkedDraftSlug;
    return slug === null || DRAFT_SLUG_RE.test(slug) ? slug : null;
  }
  return firstOpenDraftSlugInReferences(draft.references, openDrafts, siteOrigin);
}

/**
 * Carries the ticked removals across a switch into open mode.
 *
 * The two removal lists are different shapes: enacted mode ticks sitting
 * members into `removeHex`, open mode takes free credential rows, and only the
 * list belonging to the current mode is read when the action is built. Without
 * this, chaining onto an open proposal after ticking members would silently
 * drop every removal and submit a proposal that removes nobody. The ticked
 * entries are valid credentials with a known key/script kind, so they are
 * seeded as free rows. `removeHex` is left untouched, so switching back to the
 * enacted default restores the checkboxes as they were.
 */
function carryCommitteeRemovals(
  before: UpdateCommitteePanelState,
  next: UpdateCommitteePanelState,
  context: ActionContextResponse | null,
): UpdateCommitteePanelState {
  if (committeeMode(before.prev, context) !== 'enacted') return next;
  if (committeeMode(next.prev, context) !== 'open') return next;
  if (next.removeHex.length === 0) return next;

  const members = context?.committee?.members ?? [];
  const alreadyThere = new Set(next.removeFree.map(r => r.input.trim().toLowerCase()));
  const seeded: CommitteeCredentialRow[] = [];
  for (const hex of next.removeHex) {
    const key = hex.toLowerCase();
    if (alreadyThere.has(key)) continue;
    alreadyThere.add(key);
    const member = members.find(m => m.coldHex?.toLowerCase() === key);
    seeded.push({ input: hex, hexKind: member?.hasScript ? 'script' : 'key' });
  }
  if (seeded.length === 0) return next;
  return { ...next, removeFree: [...next.removeFree, ...seeded] };
}

// A protocol version chosen against one prev row is meaningless once the
// user picks a different prev, since the candidate versions are computed
// from that row's own version. Guards against a stale version surviving a
// prev switch even if a panel's onChange forgets to clear it itself.
function resetHardForkVersionOnPrevChange(
  before: HardForkPanelState,
  next: HardForkPanelState,
): HardForkPanelState {
  if (before.version === null) return next;
  const prevChanged =
    (before.prev === null) !== (next.prev === null) ||
    (before.prev !== null &&
      next.prev !== null &&
      (before.prev.txHashHex !== next.prev.txHashHex || before.prev.index !== next.prev.index));
  if (!prevChanged) return next;
  return { ...next, version: null };
}

function isEmptyContextChanges(notes: ContextChangeNotes): boolean {
  return (
    notes.prevAction === null && notes.quorum === null && notes.scriptHash === null && notes.protocolVersion === null
  );
}

/** Drops any change notes on the context, since the user has just acted on the form. A no-op when there are none. */
function clearContextChanges(context: ContextState): ContextState {
  if (isEmptyContextChanges(context.changes)) return context;
  return { ...context, changes: NO_CONTEXT_CHANGES };
}

/**
 * Merges a fresh context reading into the notes the island shows next to the
 * panel, one of the four default-affecting fields at a time: the previous
 * action, the committee quorum, the guardrails script hash, and the active
 * protocol version. A field that moved gets a freshly worded note (replacing
 * whatever it had), a field that did NOT move keeps its existing note
 * untouched, so an earlier "quorum changed" note survives an unrelated
 * refetch (say, one that only moves the previous action) instead of vanishing
 * the moment anything at all is re-read. Only a user edit
 * (clearContextChanges, wired into every edit action in the reducer below)
 * or another move of the SAME field ever takes a note away.
 *
 * `previous` is always a reading for the SAME type as `next`: setType drops
 * the context outright on a type switch (see its reducer case), so whatever
 * is here to compare against was read for the type `next` was just read for
 * too. A first load (`previous` is null) has nothing to compare, so nothing
 * has moved and `existing` (already NO_CONTEXT_CHANGES, for a first load)
 * passes straight through unchanged.
 */
function mergeContextChanges(
  previous: ActionContextResponse | null,
  next: ActionContextResponse,
  existing: ContextChangeNotes,
): ContextChangeNotes {
  if (!previous) return existing;

  const prevActionId = previous.prev?.lastEnacted?.id ?? null;
  const nextActionId = next.prev?.lastEnacted?.id ?? null;
  const prevAction =
    prevActionId === nextActionId
      ? existing.prevAction
      : nextActionId
        ? `The previous action changed to ${nextActionId}`
        : 'The previous action changed to none, this now starts the chain';

  const prevQuorum = previous.committee?.quorum ?? null;
  const nextQuorum = next.committee?.quorum ?? null;
  const quorumMoved =
    (prevQuorum?.numerator ?? null) !== (nextQuorum?.numerator ?? null) ||
    (prevQuorum?.denominator ?? null) !== (nextQuorum?.denominator ?? null);
  // No wording is specified for the quorum going missing, unlike the
  // previous action and the guardrails hash below, so a move to null clears
  // the note (there is nothing true left to say) rather than inventing text.
  const quorum = !quorumMoved
    ? existing.quorum
    : nextQuorum
      ? `The committee quorum changed to ${nextQuorum.numerator}/${nextQuorum.denominator}`
      : null;

  const prevScriptHash = previous.constitution?.scriptHash ?? null;
  const nextScriptHash = next.constitution?.scriptHash ?? null;
  const scriptHash =
    prevScriptHash === nextScriptHash
      ? existing.scriptHash
      : nextScriptHash
        ? `The guardrails script hash changed to ${shortenHash(nextScriptHash)}`
        : 'The guardrails script hash is no longer on record';

  const prevVersion = previous.protocolVersion ?? null;
  const nextVersion = next.protocolVersion ?? null;
  const versionMoved =
    (prevVersion?.major ?? null) !== (nextVersion?.major ?? null) ||
    (prevVersion?.minor ?? null) !== (nextVersion?.minor ?? null);
  // Same reasoning as the quorum: no wording for the version going missing.
  const protocolVersion = !versionMoved
    ? existing.protocolVersion
    : nextVersion
      ? `The active protocol version changed to ${nextVersion.major}.${nextVersion.minor}`
      : null;

  return { prevAction, quorum, scriptHash, protocolVersion };
}

/** The notes in the fixed order the island renders them, with the fields that have nothing to say left out. */
export function contextChangeLines(notes: ContextChangeNotes): string[] {
  return [notes.prevAction, notes.quorum, notes.scriptHash, notes.protocolVersion].filter(
    (line): line is string => line !== null,
  );
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
      // while every panel's own state is kept for a switch back. Dropping it
      // is also what clears any change notes: the next contextLoaded for the
      // new type has nothing stale to compare against.
      return {
        ...state,
        type: action.type,
        context: { status: 'idle', requestId: state.context.requestId, data: null, loadedAt: null, changes: NO_CONTEXT_CHANGES },
        dirty: true,
      };
    }

    case 'setMetadata': {
      // Covers the author fields too: "sign as author" and the name are part
      // of the metadata, so they mark the form dirty like any other edit.
      const nextMetadata = { ...state.metadata, ...action.patch };
      // A hand-edit of the references (the "Remove"/"Add reference" buttons,
      // or typing straight into a reference's URI field) can walk the tracked
      // reference away from the slug it was linked under, e.g. editing a
      // linked draft's URI to a different thread. Tracking follows the
      // references rather than trusting a slug whose row is gone. Only acts
      // on positive evidence (the caller passed a siteOrigin and the
      // references were part of this patch): with neither, tracking is left
      // exactly as it was, since a caller not touching references never has a
      // reason to walk it away.
      const linkedDraftSlug =
        action.patch.references !== undefined &&
        state.linkedDraftSlug !== null &&
        action.siteOrigin &&
        referenceIndexForSlug(nextMetadata.references, state.linkedDraftSlug, action.siteOrigin) === -1
          ? null
          : state.linkedDraftSlug;
      // Same patches, same evidence: a references edit that pushed the tracked
      // reference behind another row puts it back in front (see
      // draftReferenceFirst for why the position matters).
      const references =
        action.patch.references !== undefined && action.siteOrigin
          ? draftReferenceFirst(nextMetadata.references, linkedDraftSlug, action.siteOrigin)
          : nextMetadata.references;
      return {
        ...state,
        metadata: { ...nextMetadata, references },
        linkedDraftSlug,
        context: clearContextChanges(state.context),
        dirty: true,
      };
    }

    case 'setPanel': {
      const next =
        action.type === 'UpdateCommittee'
          ? carryCommitteeRemovals(state.panels.UpdateCommittee, action.state, state.context.data)
          : action.type === 'HardForkInitiation'
            ? resetHardForkVersionOnPrevChange(state.panels.HardForkInitiation, action.state)
            : action.state;
      return {
        ...state,
        panels: { ...state.panels, [action.type]: next },
        context: clearContextChanges(state.context),
        dirty: true,
      };
    }

    case 'contextRequested':
      return {
        ...state,
        context: {
          status: 'loading',
          requestId: action.requestId,
          data: state.context.data,
          loadedAt: state.context.loadedAt,
          changes: state.context.changes,
        },
      };

    case 'contextLoaded':
      if (action.requestId !== state.context.requestId) return state;
      return {
        ...state,
        context: {
          status: 'ready',
          requestId: action.requestId,
          data: action.data,
          loadedAt: action.now,
          changes: mergeContextChanges(state.context.data, action.data, state.context.changes),
        },
      };

    case 'contextFailed':
      if (action.requestId !== state.context.requestId) return state;
      return {
        ...state,
        context: { status: 'error', requestId: action.requestId, data: null, loadedAt: null, changes: NO_CONTEXT_CHANGES },
      };

    case 'restoreDraft': {
      const siteOrigin = action.siteOrigin ?? '';
      const linkedDraftSlug = linkedDraftSlugFromDraft(action.draft, action.openDrafts ?? [], siteOrigin);
      // A draft stored before the front-insert rule existed can carry a closed
      // draft's reference ahead of the tracked one, which is exactly the order
      // resolveDraftTopic would read the wrong way round.
      const references = draftReferenceFirst(action.draft.references, linkedDraftSlug, siteOrigin);
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
          references,
          surveyRef: action.draft.surveyRef,
        },
        panels: panelStatesFromDraft(action.draft),
        linkedDraftSlug,
        draftLinkError: null,
        dirty: false,
      };
    }

    case 'discardDraft':
      // Back to the same untouched shape a fresh visit starts from. The
      // context data and the wallet are not draft data, so neither is
      // touched: discarding the text is not the same as disconnecting a
      // wallet, and loadedAt stays with the data it is the age of. The change
      // notes ARE cleared, same as any other edit action: they describe a
      // move the panel the user was just looking at made, and that panel's
      // own state is gone the moment the draft is discarded.
      return {
        ...state,
        type: 'InfoAction',
        metadata: defaultMetadataState(action.displayName),
        panels: emptyPanelStates(),
        linkedDraftSlug: null,
        draftLinkError: null,
        context: clearContextChanges(state.context),
        dirty: false,
      };

    case 'linkDraft': {
      const uri = draftReferenceUri(action.siteOrigin, action.slug);
      const existingIndex = referenceIndexForSlug(
        state.metadata.references,
        actedOnDraftSlug(state.metadata.references, state.linkedDraftSlug, action.selectedSlug, action.siteOrigin),
        action.siteOrigin,
      );
      if (existingIndex === -1 && state.metadata.references.length >= REFERENCES_MAX) {
        return { ...state, draftLinkError: 'Remove a reference first, the list is full' };
      }
      const nextRef = { label: action.title, uri };
      // The row the pick replaces is dropped and the new one appended, then
      // draftReferenceFirst moves it to the front. That front position is the
      // whole point (resolveDraftTopic takes the FIRST Proposal Drafts
      // reference in order, and its filter only excludes a deleted thread, not
      // a locked or already-linked one), and it is the same rule a restore and
      // a hand-edit go through, so it is owned by that one function rather than
      // written out a second time here.
      const kept =
        existingIndex === -1
          ? state.metadata.references
          : state.metadata.references.filter((_, i) => i !== existingIndex);
      const references = draftReferenceFirst([...kept, nextRef], action.slug, action.siteOrigin);
      return {
        ...state,
        linkedDraftSlug: action.slug,
        metadata: { ...state.metadata, references },
        draftLinkError: null,
        context: clearContextChanges(state.context),
        dirty: true,
      };
    }

    case 'unlinkDraft': {
      const slug = actedOnDraftSlug(
        state.metadata.references,
        state.linkedDraftSlug,
        action.selectedSlug,
        action.siteOrigin,
      );
      if (!slug) {
        return { ...state, linkedDraftSlug: null, draftLinkError: null, context: clearContextChanges(state.context) };
      }
      const references = state.metadata.references.filter(
        (_, i) => i !== referenceIndexForSlug(state.metadata.references, slug, action.siteOrigin),
      );
      return {
        ...state,
        linkedDraftSlug: null,
        metadata: { ...state.metadata, references },
        draftLinkError: null,
        context: clearContextChanges(state.context),
        dirty: true,
      };
    }

    // ------------------------------------------------------------------
    // Wallet step. Every balance action is ignored unless a wallet is
    // connected, so a read that resolves after the user disconnected cannot
    // resurrect a balance for a wallet that is gone.
    // ------------------------------------------------------------------

    case 'walletConnecting':
      // A second Connect while one is running is a no-op, not a restart.
      if (state.wallet.status === 'connecting') return state;
      return { ...state, wallet: { status: 'connecting' } };

    case 'walletConnected':
      return {
        ...state,
        wallet: {
          status: 'connected',
          rewardAddressHex: action.rewardAddressHex,
          balance: { status: 'loading' },
        },
      };

    case 'walletBalanceLoading':
      if (state.wallet.status !== 'connected') return state;
      return { ...state, wallet: { ...state.wallet, balance: { status: 'loading' } } };

    case 'walletBalance':
      if (state.wallet.status !== 'connected') return state;
      return {
        ...state,
        wallet: {
          ...state.wallet,
          balance: { status: 'ready', lovelace: action.lovelace, rewardRegistered: action.rewardRegistered },
        },
      };

    case 'walletBalanceFailed':
      if (state.wallet.status !== 'connected') return state;
      return {
        ...state,
        wallet: { ...state.wallet, balance: { status: 'error', message: action.message } },
      };

    case 'walletDisconnected':
      // The reward address and the balance belong to the wallet that is being
      // dropped, so they go with it. The form itself is untouched.
      return { ...state, wallet: { status: 'none' } };
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
/**
 * The panel's own choice of previous action for a type, before it is resolved
 * against a context (that is effectivePrev's job). InfoAction is unchained and
 * has no panel, so it never chooses one. The one place this mapping is
 * written: the island's submit path and the review preview both read it here,
 * so the action that is built and the action that is previewed cannot point at
 * different predecessors.
 */
export function chosenPrev(type: GovActionFormType, panels: PanelStates): PrevActionRef | null {
  switch (type) {
    case 'InfoAction':
      return null;
    case 'NoConfidence':
      return panels.NoConfidence.prev;
    case 'HardForkInitiation':
      return panels.HardForkInitiation.prev;
    case 'NewConstitution':
      return panels.NewConstitution.prev;
    case 'UpdateCommittee':
      return panels.UpdateCommittee.prev;
  }
}

export function effectivePrev(
  chosen: PrevActionRef | null,
  context: ActionContextResponse | null,
): PrevActionRef | null {
  if (chosen) return chosen;
  const root = context?.prev?.lastEnacted;
  if (!root) return null;
  return { txHashHex: root.txHash, index: root.index };
}

/**
 * The part of the form state a draft is made of. Narrower than the whole
 * state on purpose: the live context is never stored, and taking only these
 * keys lets the persist effect depend on them instead of on every context
 * transition.
 */
export type DraftableState = Pick<GovActionFormState, 'metadata' | 'type' | 'panels' | 'linkedDraftSlug'>;

/** Builds the v2 draft for the current state: the type, the metadata, every panel, the tracked draft link. */
export function draftFromState(state: DraftableState): GovActionDraft {
  return {
    v: 2,
    type: state.type,
    ...state.metadata,
    panels: state.panels,
    linkedDraftSlug: state.linkedDraftSlug,
  };
}

/**
 * The reference row the tracked draft slug points at, or null when nothing is
 * tracked or the reference was since removed by hand. Lets the control show a
 * title for a tracked slug that has fallen out of the open drafts list (a
 * closed draft still keeps its reference and its label).
 */
export function linkedDraftReference(
  state: Pick<GovActionFormState, 'metadata' | 'linkedDraftSlug'>,
  siteOrigin: string,
): { label: string; uri: string } | null {
  if (!state.linkedDraftSlug) return null;
  const index = referenceIndexForSlug(state.metadata.references, state.linkedDraftSlug, siteOrigin);
  return index === -1 ? null : state.metadata.references[index];
}

/**
 * What the "Link a Proposal Draft" select should show as chosen: the tracked
 * slug while it still has a matching reference (setMetadata keeps the two in
 * sync, see the reducer), else the first reference that names an open draft.
 * That fallback is what makes a hand-typed or hand-edited reference to an open
 * draft show up as selected even though the control was never used to add it.
 * The same value goes back into linkDraft and unlinkDraft as their
 * `selectedSlug`, so the control acts on exactly the row it is showing.
 */
export function effectiveLinkedDraftSlug(
  state: Pick<GovActionFormState, 'metadata' | 'linkedDraftSlug'>,
  openDrafts: readonly { slug: string }[],
  siteOrigin: string,
): string | null {
  if (
    state.linkedDraftSlug &&
    referenceIndexForSlug(state.metadata.references, state.linkedDraftSlug, siteOrigin) !== -1
  ) {
    return state.linkedDraftSlug;
  }
  return firstOpenDraftSlugInReferences(state.metadata.references, openDrafts, siteOrigin);
}

/**
 * True when more than one reference points at an open draft or at the
 * tracked slug. The resolver on the server takes the first Proposal Drafts
 * reference it finds (see resolveDraftTopic), so a second reference naming a
 * different open draft could make gov-sync link a thread the "Link a
 * Proposal Draft" control never showed as chosen. Readiness (see
 * readiness.ts) blocks submit on this rather than silently trusting the
 * first match.
 */
export function draftConflict(
  state: Pick<GovActionFormState, 'metadata' | 'linkedDraftSlug'>,
  openDrafts: readonly { slug: string }[],
  siteOrigin: string,
): boolean {
  const candidates = new Set(openDrafts.map((d) => d.slug));
  if (state.linkedDraftSlug) candidates.add(state.linkedDraftSlug);
  const refSlugs = draftSlugsFromReferences(state.metadata.references, siteOrigin);
  return refSlugs.filter((slug) => candidates.has(slug)).length > 1;
}

function panelsAreEmpty(panels: PanelStates): boolean {
  const empty = emptyPanelStates();
  return (
    panels.NoConfidence.prev === null &&
    panels.HardForkInitiation.prev === null &&
    panels.HardForkInitiation.version === null &&
    panels.NewConstitution.prev === null &&
    panels.NewConstitution.text === empty.NewConstitution.text &&
    panels.NewConstitution.scriptHashHex === null &&
    panels.UpdateCommittee.prev === null &&
    panels.UpdateCommittee.removeHex.length === 0 &&
    panels.UpdateCommittee.removeFree.length === 0 &&
    panels.UpdateCommittee.add.length === 0 &&
    panels.UpdateCommittee.quorum === null
  );
}

/** What "untouched" means for the fields that default to more than empty. */
export interface FormDefaults {
  /** The signed-in display name, prefilled as the author name. */
  authorName: string;
}

/**
 * True when there is nothing worth storing: no metadata text, the author
 * fields still on their defaults (signing on, name is the prefilled display
 * name), the type still on the InfoAction default, and every panel untouched.
 * A filled panel with empty metadata is therefore kept, which is the whole
 * point of storing the panels in the draft.
 */
export function isFormBlank(state: DraftableState, defaults: FormDefaults): boolean {
  const m = state.metadata;
  const authorBlank = m.signAsAuthor === true && m.authorName === defaults.authorName;
  const metadataBlank =
    !m.title.trim() &&
    !m.abstract.trim() &&
    !m.motivation.trim() &&
    !m.rationale.trim() &&
    authorBlank &&
    m.references.length === 0 &&
    !m.surveyRef.trim();
  // A tracked draft slug always has a reference row behind it (setMetadata
  // drops the slug the moment its row is gone), so references.length already
  // covers the draft link.
  return metadataBlank && state.type === 'InfoAction' && panelsAreEmpty(state.panels);
}

// ---------------------------------------------------------------------------
// Panel validation
//
// One validator per chained panel that has rules of its own, each returning
// the value the action needs or the message to show. The panels render
// through these and the submit shell builds the action through them with the
// FRESH context, so what the form accepts and what is proposed cannot drift.
// ---------------------------------------------------------------------------

/** Shown when the chosen previous action is gone from the fresh submit-time context. */
export const PREV_ACTION_CHANGED = 'The previous action changed, review the selection.';

/** A panel's validation outcome: the value the action needs, or one message to show. */
export type PanelValidation<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A panel's lenient reading, for the review preview: whatever of the payload
 * is usable right now, plus the names of the fields still standing between
 * the form and a submittable action. The validators above answer "may this be
 * submitted", which is a yes-or-no question, and the preview needs the half of an
 * answer that a no still contains, since an incomplete form is previewed too.
 */
export interface PanelDescription<T> {
  payloadPart: T | null;
  missing: string[];
}

/**
 * The hard fork panel's rules: a version has to be picked, the active version
 * has to be readable, and the pick has to still be one of the versions that
 * may follow the base (see hardForkBaseVersion). The last check is what
 * catches a chain that moved while the form was open.
 */
export function validateHardForkPanel(
  panel: HardForkPanelState,
  context: ActionContextResponse | null,
): PanelValidation<ProtocolVersion> {
  const version = panel.version;
  if (!version) return { ok: false, error: 'Choose the protocol version to propose.' };
  const active = context?.protocolVersion ?? null;
  if (!active) {
    return { ok: false, error: 'The current protocol version could not be read from the chain. Please try again.' };
  }
  const base = hardForkBaseVersion(panel.prev, context?.prev?.open ?? [], active);
  if (!base) {
    return {
      ok: false,
      error:
        'The protocol version of the chosen previous action could not be read, so no version can be proposed against it.',
    };
  }
  if (!versionsThatFollow(base, active).some(c => c.major === version.major && c.minor === version.minor)) {
    return {
      ok: false,
      error: `Protocol version ${version.major}.${version.minor} no longer follows the current chain state. ${PREV_ACTION_CHANGED}`,
    };
  }
  return { ok: true, value: version };
}

/**
 * The hard fork panel read leniently: the version the user picked is what the
 * preview shows even when it no longer validates, because a version that has
 * fallen behind the chain is still what is on screen in the field. Every
 * failure reduces to the one field the panel has.
 */
export function describeHardForkPanel(
  panel: HardForkPanelState,
  context: ActionContextResponse | null,
): PanelDescription<ProtocolVersion> {
  const result = validateHardForkPanel(panel, context);
  if (result.ok) return { payloadPart: result.value, missing: [] };
  return { payloadPart: panel.version, missing: ['Protocol version'] };
}

/** The constitution panel's two fields as read, each with the reason it is not usable yet. */
interface NewConstitutionReading {
  text: string;
  /** The resolved guardrails hash, or null for "no script" AND for a malformed one. */
  scriptHashHex: string | null;
  textError: string | null;
  scriptError: string | null;
}

/**
 * Reads the panel's two fields once, so the strict validator and the lenient
 * describer below cannot disagree about what the field holds or why it is not
 * usable. An untouched hash field means the hash of the constitution in force,
 * which is what the field itself shows, and an empty one means no script at all.
 */
function readNewConstitutionPanel(
  panel: NewConstitutionPanelState,
  context: ActionContextResponse | null,
): NewConstitutionReading {
  const text = panel.text;
  let textError: string | null = null;
  if (!text.trim()) textError = 'Enter the constitution text.';
  else if (new TextEncoder().encode(text).length > CONSTITUTION_DOCUMENT_MAX_BYTES) {
    textError = 'The constitution document is over the 256 KiB limit.';
  }
  const hash = (panel.scriptHashHex ?? context?.constitution?.scriptHash ?? '').trim();
  const scriptError =
    hash !== '' && !HEX_HASH_224_RE.test(hash) ? 'A guardrails script hash is exactly 56 hex characters.' : null;
  return {
    text,
    scriptHashHex: scriptError !== null || hash === '' ? null : hash.toLowerCase(),
    textError,
    scriptError,
  };
}

/**
 * The new constitution panel's rules: a non-empty document within the byte
 * cap, and a guardrails script hash that is either empty or 56 hex chars.
 */
export function validateNewConstitutionPanel(
  panel: NewConstitutionPanelState,
  context: ActionContextResponse | null,
): PanelValidation<{ text: string; scriptHashHex: string | null }> {
  const reading = readNewConstitutionPanel(panel, context);
  if (reading.textError) return { ok: false, error: reading.textError };
  if (reading.scriptError) return { ok: false, error: reading.scriptError };
  return { ok: true, value: { text: reading.text, scriptHashHex: reading.scriptHashHex } };
}

/**
 * The constitution panel read leniently: the text as typed (so the preview can
 * hash exactly the bytes that would be published) and the guardrails hash when
 * it is usable, with the unusable fields named.
 */
export function describeNewConstitutionPanel(
  panel: NewConstitutionPanelState,
  context: ActionContextResponse | null,
): PanelDescription<{ text: string; scriptHashHex: string | null }> {
  const reading = readNewConstitutionPanel(panel, context);
  const missing: string[] = [];
  if (reading.textError) missing.push('Constitution text');
  if (reading.scriptError) missing.push('Guardrails script hash');
  return { payloadPart: { text: reading.text, scriptHashHex: reading.scriptHashHex }, missing };
}

// ---------------------------------------------------------------------------
// Committee panel validation
// ---------------------------------------------------------------------------

/**
 * Which committee state the diff will meet: today's committee when the
 * proposal chains onto the enacted root, an unknown future one when it chains
 * onto a proposal that is still open.
 */
export function committeeMode(
  prev: PrevActionRef | null,
  context: ActionContextResponse | null,
): 'enacted' | 'open' {
  if (!prev) return 'enacted';
  const open = context?.prev?.open ?? [];
  return open.some(o => matchesRef(prev, o)) ? 'open' : 'enacted';
}

/** A positive-looking integer field parsed from its typed text, or null when it is not one. */
function parseIntegerField(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * The committee panel's typed text after parsing, before any rule is applied.
 * Rows that could not be parsed are simply absent. Carried out of the
 * validator so the preview can render the rows that ARE readable while the
 * others are still being typed, without parsing the panel a second time.
 */
export interface CommitteePanelParse {
  remove: ColdCredential[];
  add: AddedMember[];
  /** null when the quorum is neither typed readably nor known from the context. */
  quorum: Quorum | null;
}

/**
 * Turns the committee panel's typed text into the validator's input and runs
 * it. Rows whose credential or epoch cannot be parsed are reported as errors
 * on their own field and left out of the validated value, so a half-typed row
 * blocks submit without hiding the other rows' problems.
 *
 * Used by the panel to render and by the shell to build the action, so the
 * two can never disagree about what is valid.
 */
export function validateCommitteePanel(
  panel: UpdateCommitteePanelState,
  context: ActionContextResponse | null,
): {
  errors: ValidationError[];
  warnings: ValidationWarning[];
  value: CommitteeUpdate | null;
  mode: 'enacted' | 'open';
  parsed: CommitteePanelParse;
} {
  const mode = committeeMode(panel.prev, context);
  const parseErrors: ValidationError[] = [];
  const committee = context?.committee ?? null;
  const members: CurrentMember[] = (committee?.members ?? [])
    .filter(
      (m): m is { coldHex: string; hasScript: boolean; expirationEpoch: number | null; name: string | null } =>
        m.coldHex !== null,
    )
    .map(m => ({ hashHex: m.coldHex.toLowerCase(), isScript: m.hasScript, expirationEpoch: m.expirationEpoch }));

  const remove: ColdCredential[] = [];
  if (mode === 'enacted') {
    panel.removeHex.forEach((hex, i) => {
      const member = members.find(m => m.hashHex === hex.toLowerCase());
      if (!member) {
        parseErrors.push({ field: `remove[${i}]`, message: 'this member is no longer on the committee' });
        return;
      }
      remove.push({ hashHex: member.hashHex, isScript: member.isScript });
    });
  } else {
    panel.removeFree.forEach((row, i) => {
      const parsed = parseColdCredential(row.input, row.hexKind);
      if (!parsed) {
        parseErrors.push({ field: `remove[${i}]`, message: 'not a cold credential (cc_cold... or 56 hex characters)' });
        return;
      }
      remove.push(parsed);
    });
  }

  const add: AddedMember[] = [];
  panel.add.forEach((row, i) => {
    const parsed = parseColdCredential(row.input, row.hexKind);
    if (!parsed) {
      parseErrors.push({ field: `add[${i}].credential`, message: 'not a cold credential (cc_cold... or 56 hex characters)' });
      return;
    }
    const expiry = parseIntegerField(row.expiryEpoch);
    if (expiry === null) {
      parseErrors.push({ field: `add[${i}].expiryEpoch`, message: 'expiry epoch must be a whole number' });
      return;
    }
    add.push({ credential: parsed, expiryEpoch: expiry });
  });

  // An untouched quorum falls back to the one in force: the field shows that
  // value, so validating anything else would contradict what is on screen.
  let quorum: Quorum | null = panel.quorum === null ? (committee?.quorum ?? null) : null;
  if (panel.quorum) {
    const numerator = parseIntegerField(panel.quorum.numerator);
    const denominator = parseIntegerField(panel.quorum.denominator);
    if (numerator === null) {
      parseErrors.push({ field: 'quorum.numerator', message: 'quorum numerator must be a whole number' });
    }
    if (denominator === null) {
      parseErrors.push({ field: 'quorum.denominator', message: 'quorum denominator must be a whole number' });
    }
    if (numerator !== null && denominator !== null) quorum = { numerator, denominator };
  }

  const result = validateCommitteeUpdate({
    mode,
    epoch: context?.epoch ?? 0,
    maxTermLength: committee?.maxTermLength ?? null,
    current: members,
    remove,
    add,
    quorum,
    currentQuorum: committee?.quorum ?? null,
  });

  const parsed: CommitteePanelParse = { remove, add, quorum };
  if (!result.ok) return { errors: [...parseErrors, ...result.errors], warnings: [], value: null, mode, parsed };
  if (parseErrors.length > 0) return { errors: parseErrors, warnings: result.warnings, value: null, mode, parsed };
  return { errors: [], warnings: result.warnings, value: result.value, mode, parsed };
}

/** The label the preview shows for a committee error that names no single field. */
const COMMITTEE_WHOLE_PANEL_LABEL = 'Committee changes';

/** A committee validation error's field path as a field name a reader recognizes. */
function committeeFieldLabel(field: string): string {
  const remove = /^remove\[(\d+)\]$/.exec(field);
  if (remove) return `Member to remove ${Number(remove[1]) + 1}`;
  const addCredential = /^add\[(\d+)\]\.credential$/.exec(field);
  if (addCredential) return `Member to add ${Number(addCredential[1]) + 1}`;
  const addExpiry = /^add\[(\d+)\]\.expiryEpoch$/.exec(field);
  if (addExpiry) return `Expiry epoch for addition ${Number(addExpiry[1]) + 1}`;
  if (field === 'quorum.numerator') return 'Quorum numerator';
  if (field === 'quorum.denominator') return 'Quorum denominator';
  return COMMITTEE_WHOLE_PANEL_LABEL;
}

/**
 * The committee panel read leniently: every row that parsed, plus the field
 * names of the ones that did not. A malformed credential is reported, never
 * thrown, so a half-typed row does not take the whole preview down with it.
 *
 * The payload part is always returned, quorum included when it is known, so
 * the preview can show the diff that IS readable next to the list of what is
 * not.
 */
export function describeCommitteePanel(
  panel: UpdateCommitteePanelState,
  context: ActionContextResponse | null,
): PanelDescription<CommitteePanelParse> {
  const result = validateCommitteePanel(panel, context);
  if (result.value) return { payloadPart: result.value, missing: [] };
  const labels: string[] = [];
  for (const error of result.errors) {
    const label = committeeFieldLabel(error.field);
    if (!labels.includes(label)) labels.push(label);
  }
  // "Nothing to change" is judged on the rows that parsed, so while a row is
  // still half typed it says nothing the named row does not already say.
  const missing = labels.length > 1 ? labels.filter((l) => l !== COMMITTEE_WHOLE_PANEL_LABEL) : labels;
  return { payloadPart: result.parsed, missing };
}

/**
 * The chosen type's panel verdict for the readiness list: ok with no message,
 * ok false with the one message to point at, or null when the panel has no
 * rules of its own (InfoAction, NoConfidence).
 *
 * Null while there is no context at all: a panel judged against a context that
 * has not arrived would report the missing context twice, once as itself and
 * once as a panel error. The readiness list already names the missing context.
 *
 * Pure, so the whole per-type verdict is unit-tested without a DOM, and built
 * on the same validate*Panel functions the panels render through and the
 * submit path builds the action with.
 */
export function panelReadiness(
  type: GovActionFormType,
  panels: PanelStates,
  context: ActionContextResponse | null,
): { ok: boolean; error: string } | null {
  if (!context) return null;
  switch (type) {
    case 'InfoAction':
    case 'NoConfidence':
      return null;
    case 'HardForkInitiation': {
      const result = validateHardForkPanel(panels.HardForkInitiation, context);
      return result.ok ? { ok: true, error: '' } : { ok: false, error: result.error };
    }
    case 'NewConstitution': {
      const result = validateNewConstitutionPanel(panels.NewConstitution, context);
      return result.ok ? { ok: true, error: '' } : { ok: false, error: result.error };
    }
    case 'UpdateCommittee': {
      const result = validateCommitteePanel(panels.UpdateCommittee, context);
      return result.value === null
        ? { ok: false, error: result.errors[0]?.message ?? 'The committee update is not valid yet.' }
        : { ok: true, error: '' };
    }
  }
}
