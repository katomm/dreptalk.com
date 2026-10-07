// React island: client-side, non-custodial governance-action submission
// flow. preprod-only, Beta internal tool.
//
// Non-custodial: the wallet signs and submits, the server never sees a
// private key. The flow, form first and wallet last: (1) fetch the current gov
// action deposit and voting thresholds so the user knows what they are
// committing, (2) pick the action type and fill its panel plus the shared
// CIP-108 fields, all without a wallet and even without an extension,
// (3) connect a plain CIP-30 wallet (no CIP-95, a proposal needs no DRep key)
// in the section at the end and check the balance against the deposit,
// (4) host the metadata via the /api/gov-action routes, (5) build/sign/submit
// the propose tx via submitGovAction. A treasury withdrawal also re-checks its
// guardrail and its recipients' registration right before the author
// signature, and its guardrails script is evaluated through
// /api/gov-action/evaluate during the build.
//
// The form state, including the wallet step, lives in the govActionFormState
// reducer, so the type switch, the per-type panels, the out-of-order context
// guard and the wallet transitions are unit-tested without a DOM. The enabled
// CIP-30 api object itself stays in enabledApiRef: it is a live IPC handle,
// not data.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { CopyButton } from '@/components/CopyButton.js';
import { useCardanoWallets, rememberWallet, recallWallet } from '@/lib/wallet/useCardanoWallets.js';
import { submitGovAction } from '@/lib/governance/govActionTx.js';
import { govActionSubmissionAvailable, govActionTypeAvailable } from '@/lib/governance/submissionGate.js';
import { collectWalletUtxos, totalLovelace } from '@/lib/governance/walletUtxos.js';
import { fetchStakeRegistration, fetchStakeRegistrations, rewardAddressToStakeBech32 } from '@/lib/governance/stakeAccount.js';
import { KEEP_STAKE_KEY_REGISTERED, latestRefundEpoch } from '@/lib/governance/depositRefund.js';
import { epochWithDate } from '@/lib/governance/epochLabel.js';
import type { WalletApi } from '@/lib/governance/walletUtxos.js';
import { readinessReasons } from '@/lib/governance/readiness.js';
import { formatAdaPlain } from '@/lib/format/ada.js';
import {
  INFO_TITLE_MAX,
  INFO_ABSTRACT_MAX,
  INFO_MOTIVATION_MAX,
  INFO_RATIONALE_MAX,
  REFERENCE_LABEL_MAX,
  REFERENCE_URI_MAX,
  REFERENCES_MAX,
} from '@/lib/governance/infoActionLimits.js';
import { parseSurveyRefInput } from '@/lib/governance/surveyRef.js';
import {
  govActionDraftKey,
  loadGovActionDraft,
  saveGovActionDraft,
  clearGovActionDraft,
} from '@/lib/governance/govActionDraft.js';
import {
  govActionFormReducer,
  initialGovActionFormState,
  effectivePrev,
  draftFromState,
  isFormBlank,
  linkedDraftReference,
  effectiveLinkedDraftSlug,
  draftConflict,
  chosenPrev,
  panelReadiness,
  validateCommitteePanel,
  validateHardForkPanel,
  validateNewConstitutionPanel,
  validateTreasuryPanel,
  contextChangeLines,
  PREV_ACTION_CHANGED,
} from '@/lib/governance/govActionFormState.js';
import { previewModelFromForm } from '@/lib/governance/previewModel.js';
import { startStatusPolling } from '@/lib/governance/successPolling.js';
import type { GovActionStatusResponse, SuccessPollState } from '@/lib/governance/successPolling.js';
import type { OpenProposalDraft } from '@/lib/db/proposalDrafts.js';
import type { DepositState } from '@/lib/governance/govActionFormState.js';
import { needsContext, refStillPresent } from '@/lib/governance/prevAction.js';
import {
  checkTreasuryRows,
  RECIPIENT_UNREGISTERED,
  RECIPIENTS_CHECK_FAILED_AT_SUBMIT,
  withAddressAdded,
} from '@/lib/governance/treasuryWithdrawals.js';
import { guardrailDecision, GUARDRAIL_UNKNOWN_MESSAGE } from '@/lib/governance/guardrailScript.js';
import { mapGuardrailBuildError } from '@/lib/governance/govActionErrors.js';
import type { GovActionFormType, PrevActionRef } from '@/lib/governance/prevAction.js';
import type { GovActionSpec } from '@/lib/governance/govActionParts.js';
import type { ActionContextResponse } from '@/lib/governance/actionContextHandler.js';
import { protocolParamsFromEpochParams } from '@/lib/koios/protocolParamsAdapter.js';
import type { EpochParamsRow } from '@/lib/koios/client.js';
import TypeSelector, { govActionFormTypeLabel } from '@/components/govAction/TypeSelector.js';
import PrevActionField from '@/components/govAction/PrevActionField.js';
import HardForkPanel from '@/components/govAction/HardForkPanel.js';
import NewConstitutionPanel from '@/components/govAction/NewConstitutionPanel.js';
import UpdateCommitteePanel from '@/components/govAction/UpdateCommitteePanel.js';
import TreasuryPanel from '@/components/govAction/TreasuryPanel.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { resolveNetwork, txExplorerUrl } from '@/lib/config/network.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import { inputStyle, labelStyle, linkButtonStyle } from '@/components/drepFormStyles.js';
import { ErrorIcon, InfoIcon } from '@/components/govAction/icons.js';
import SignAndSubmit from '@/components/govAction/SignAndSubmit.js';
import DraftRestoreBanner from '@/components/govAction/DraftRestoreBanner.js';
import DraftLinkControl from '@/components/govAction/DraftLinkControl.js';
import ReviewModal from '@/components/govAction/ReviewModal.js';
import ReadinessList from '@/components/govAction/ReadinessList.js';
import MarkdownEditor, { markdownBodyId } from '@/components/MarkdownEditor.js';

// Mirrors the un-exported AUTHOR_NAME_MAX in infoActionMetadataHandler.ts, kept
// in sync manually since that constant is server-internal.
const AUTHOR_NAME_MAX = 120;

// Pause after the last address edit before the registration read, so typing
// an address does not cost one request per keystroke.
const RECIPIENT_CHECK_DEBOUNCE_MS = 400;

// The real CIP-30 DataSignature shape (COSE_Sign1 signature + COSE_Key), which
// is what every wallet actually returns and what the author witness reads.
// The shared tx WalletApi cannot use it: it has to mirror whatever
// Client.withCip30 accepts, and the SDK types that return value as
// {payload, signature} (sdk/wallet/Wallet.d.ts SignedMessage), a shape no
// CIP-30 wallet produces. The same package defines a SECOND SignedMessage in
// cose/SignData.d.ts that IS {signature, key}, so the two disagree upstream.
// Hence this island keeps the correct shape and casts once at the hand-off.
type DataSignature = { signature: string; key: string };

interface Cip30Api {
  // Never called again on an already-enabled api, typed as never so a stray
  // call anywhere below this point is a compile error, not a runtime bug.
  enable?: never;
  getNetworkId(): Promise<number>;
  getRewardAddresses(): Promise<string[]>;
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getUtxos(): Promise<string[]>;
  signData(addressHex: string, payloadHex: string): Promise<DataSignature>;
  signTx(txHex: string, partial: boolean): Promise<string>;
  submitTx(txHex: string): Promise<string>;
}

interface InfoActionFields {
  title: string;
  abstract: string;
  motivation: string;
  rationale: string;
}

// The form is always on screen, so the phase is only about what the page is
// doing right now. Connecting is wallet state, not a phase: it no longer
// hides anything.
type Phase =
  | { status: 'editing' }
  | { status: 'submitting' }
  | { status: 'success'; txHash: string; authored: boolean; refundEpoch: number | null }
  // `step` decides where the message goes: a connect error sits next to the
  // Connect button, a submit error under the Submit button. Neither one takes
  // the form off the screen.
  | { status: 'error'; message: string; step: 'connect' | 'submit'; detail?: string | null };

export interface SubmitGovActionProps {
  network: CardanoNetwork;
  /**
   * The signed-in user's display name, resolved by the page the way /home/
   * resolves it. Prefilled as the author name, with signing on by default.
   * Empty when there is none to show.
   */
  displayName: string;
  /**
   * Open Proposal Drafts threads for the "Link a Proposal Draft" control,
   * an SSR prop rather than a route (see the design doc's decision 3).
   * Optional and defaulted to none, so every existing render call that
   * predates this control (and every test that does not care about it)
   * stays valid.
   */
  openDrafts?: readonly OpenProposalDraft[];
  /**
   * What draftSlugsFromReferences compares a reference's URL against
   * (NetworkConfig.siteOrigin), not the browser's own origin. Optional:
   * falls back to the network's own config, which is what new.astro passes
   * explicitly anyway.
   */
  siteOrigin?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Parses the passthrough `gov_action_deposit` Koios field (number or numeric string) to lovelace. */
function parseDepositLovelace(raw: unknown): bigint | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return BigInt(Math.trunc(raw));
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
  return null;
}

// Matches the exact message thrown by submitGovAction's funding-shortfall
// guard (see govActionTx.ts), so the required/available numbers can be
// reformatted in ada and the "no UTxOs at all" case can get its own wording.
const INSUFFICIENT_FUNDS_RE = /^Insufficient tADA for the deposit: need (\d+) lovelace, wallet has (\d+)\.$/;

/**
 * Maps a submitGovAction failure to a readable message.
 *
 * The network guard ran at connect time, but it proves less than it looks:
 * CIP-30 getNetworkId() answers 0 for EVERY testnet, so a wallet on Preview
 * passes the preprod check unchanged (see networkGuard.ts). That is exactly why
 * the zero-UTxO case earns its own wording. A wallet that cleared the guard and
 * then shows no preprod UTxOs at all is far more often on Preview than
 * genuinely empty, and telling the user to fund an already-funded wallet would
 * send them the wrong way.
 *
 * A node-side rejection that names the chosen previous action is the same
 * problem the submit-time freshness check guards against, one step later: the
 * chain moved between the refetch and the block. It gets the same hint.
 * Anything else (including a wallet-rejected signTx) falls back to the shared
 * CIP-30 error reader.
 */
/**
 * Shown when the wallet extension answers with a different reward address than
 * the one read at connect time, which means the user switched accounts in the
 * extension while the form was open.
 */
const WALLET_ACCOUNT_CHANGED = 'The wallet account changed. Connect the wallet again.';

function mapSubmitError(err: unknown, prev: PrevActionRef | null): { message: string; detail?: string | null } {
  const raw = err instanceof Error ? err.message : String(err);
  const m = INSUFFICIENT_FUNDS_RE.exec(raw);
  if (m) {
    const [, requiredLovelace, availableLovelace] = m;
    if (availableLovelace === '0') {
      return {
        message:
          'No preprod UTxOs found for this wallet (is it a Preview wallet? Preview and Preprod are separate testnets with separate funds).',
      };
    }
    return {
      message: `Insufficient tADA: this proposal needs about ${formatAdaPlain(requiredLovelace)} tADA (deposit plus fee headroom), but your wallet only has ${formatAdaPlain(availableLovelace)} tADA.`,
    };
  }
  // The guardrail evaluation and the collateral it needs come with their own
  // wording, the script error itself goes into a disclosure.
  const guardrail = mapGuardrailBuildError(err);
  if (guardrail) return guardrail;
  const readable = readableError(err);
  if (prev && raw.toLowerCase().includes(prev.txHashHex.toLowerCase())) {
    return { message: `${readable} ${PREV_ACTION_CHANGED}` };
  }
  return { message: readable };
}

/**
 * Wording for a context route error code that has its own sentence. Any other
 * code, or none, gets the generic outage line.
 */
const CONTEXT_ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([['guardrail_unknown', GUARDRAIL_UNKNOWN_MESSAGE]]);

/**
 * What stops a submit right after the context refetch, before the author
 * signature and before anything is pinned, or null when nothing does. A
 * treasury withdrawal has no chain to re-check: a guardrails script that
 * changed since the page loaded, or one nothing proves any more, takes the
 * chain checks' place, and the recipients' registration (read again at the
 * same point) comes second. The chained types need a fresh chain state whose
 * root still holds the previous action the form chose.
 */
function preSignatureProblem(
  type: GovActionFormType,
  prev: PrevActionRef | null,
  fresh: ActionContextResponse | null,
  recipientsProblem: string | null,
): string | null {
  if (type === 'TreasuryWithdrawals') {
    // A failed refetch (null) is a guardrail nobody could check, which
    // guardrailDecision words as GUARDRAIL_UNKNOWN_MESSAGE.
    const decision = guardrailDecision(fresh?.guardrail);
    if (!decision.ok) return decision.message;
    return recipientsProblem;
  }
  if (!fresh?.prev) return 'Could not re-check the current chain state. Please try again.';
  if (!refStillPresent(prev, fresh.prev)) return PREV_ACTION_CHANGED;
  return null;
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

const helpStyle: CSSProperties = { display: 'block', fontSize: '0.8125rem', color: 'var(--muted)', margin: '0 0 0.375rem' };
const labelRowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' };
const counterStyle: CSSProperties = { fontSize: '0.75rem', color: 'var(--muted)', flexShrink: 0 };

/** A labelled field with a live "used / max" counter and a helper line, matching DrepProfileFields' CountedField. */
// The three CIP-108 Markdown fields, in form order.
const MARKDOWN_FIELDS = [
  { key: 'abstract', label: 'Abstract', max: INFO_ABSTRACT_MAX, help: 'Brief summary of what this proposal is about.', placeholder: 'What is this proposal about?', rows: 4 },
  { key: 'motivation', label: 'Motivation', max: INFO_MOTIVATION_MAX, help: 'Why this proposal is needed.', placeholder: 'Why is this proposal needed?', rows: 8 },
  { key: 'rationale', label: 'Rationale', max: INFO_RATIONALE_MAX, help: 'Detailed reasoning behind the proposal.', placeholder: 'Explain the reasoning in detail...', rows: 10 },
] as const;

function CountedField(props: { id: string; label: string; count: number; max: number; help: string; children: ReactNode }) {
  return (
    <div>
      <div style={labelRowStyle}>
        <label htmlFor={props.id} style={labelStyle}>{props.label}</label>
        <span style={counterStyle}>{props.count} / {props.max}</span>
      </div>
      <span style={helpStyle}>{props.help}</span>
      {props.children}
    </div>
  );
}

/** Deposit callout shown above the connect/form flow, regardless of wallet state. */
function DepositInfo({ deposit }: { deposit: DepositState }) {
  return (
    <div className={`callout callout--${deposit.status === 'error' ? 'error' : 'info'}`} role="status">
      {deposit.status === 'error' ? <ErrorIcon /> : <InfoIcon />}
      <div className="callout__body">
        {deposit.status === 'loading' && <p style={{ margin: 0 }}>Loading the current governance action deposit...</p>}
        {deposit.status === 'error' && <p style={{ margin: 0 }}>{deposit.message}</p>}
        {deposit.status === 'ready' && (
          <>
            <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>
              Governance action deposit: {formatAdaPlain(deposit.lovelace)} tADA
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--muted)', fontSize: '0.8125rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <li>This is the current on-chain governance action deposit.</li>
              <li>The transaction reads the live protocol parameters when you submit. Those are authoritative and can differ slightly from this figure.</li>
              <li>The deposit is refunded to your reward address once the action is ratified, enacted, or expires. {KEEP_STAKE_KEY_REGISTERED}</li>
              <li>Your wallet needs at least this much tADA, plus a small network fee, to submit.</li>
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export default function SubmitGovAction({ network, displayName, openDrafts = [], siteOrigin }: SubmitGovActionProps) {
  // resolveNetwork returns the same cached config object for a given
  // network every call, so this needs no memoization to stay referentially
  // stable across renders.
  const networkConfig = resolveNetwork(network);
  // What draftSlugsFromReferences compares a reference's URL against. The
  // prop always carries this from new.astro, the fallback only matters for a
  // test or a caller that omits it. `||`, not `??`: an explicit empty string
  // is exactly as unusable as a missing prop, since it would build a
  // reference URI with no origin at all.
  const draftSiteOrigin = siteOrigin || networkConfig.siteOrigin;
  const { wallets, selected, setSelected: setSelectedWallet } = useCardanoWallets();
  // Whether the user clicked a wallet in the picker. The hook always fills a
  // selection (remembered wallet, else the first one found), which says
  // nothing about the user having chosen between several wallets.
  const walletPickedRef = useRef(false);
  const setSelected = (key: string) => {
    walletPickedRef.current = true;
    setSelectedWallet(key);
  };
  // Set while the recipient panel's connect button waits for the wallet.
  const addOwnAfterConnectRef = useRef(false);
  const [focusPickerToken, setFocusPickerToken] = useState(0);
  const [phase, setPhase] = useState<Phase>({ status: 'editing' });
  const [deposit, setDeposit] = useState<DepositState>({ status: 'loading' });
  // The /epoch_params row, kept raw: the preview feeds it to the shared
  // on-chain decoder, which reads the snake_case Koios keys (protocol_major
  // and friends) that protocolParamsFromEpochParams maps away. The mapped form
  // the threshold sentences need is derived from it rather than stored
  // alongside it, so the two cannot disagree about which row is current.
  const [epochParamsRow, setEpochParamsRow] = useState<EpochParamsRow | null>(null);
  const params = useMemo(
    () => (epochParamsRow ? protocolParamsFromEpochParams(epochParamsRow) : null),
    [epochParamsRow],
  );
  // displayName is the lazy initializer's own argument (not read through a
  // closure), so useReducer only ever prefills the author name once, at
  // mount, even if the prop identity changes on a later render.
  const [state, dispatch] = useReducer(govActionFormReducer, displayName, initialGovActionFormState);
  // Bumped by the retry button so the context effect runs again for the same type.
  const [contextAttempt, setContextAttempt] = useState(0);
  // When a stored draft was restored: its savedAt (a relative time to show),
  // null (restored but predates savedAt), or undefined (nothing restored,
  // either a fresh visit or the draft was discarded). Drives the banner.
  const [restoredAt, setRestoredAt] = useState<number | null | undefined>(undefined);
  // The review modal. Optional and never gated on readiness: an incomplete
  // form previews too, with the missing fields listed inside.
  const [reviewOpen, setReviewOpen] = useState(false);
  // Focus goes back here when the modal closes, whichever way it closed.
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // A live read of `phase` for the visibility effect below, whose listener is
  // a closure kept across renders (see that effect's own dependency list) and
  // so cannot see a `phase` update through render alone. Synced after every
  // commit, which is well before any later user-driven event (a tab regaining
  // visibility) can fire, so it is current by the time it matters, including
  // the 'submitting' phase set synchronously at the top of handleSubmit.
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Cached CIP-30 api: avoids a second enable() IPC round trip on submit,
  // mirroring DRepService/VotePanel's enabledApiRef pattern.
  const enabledApiRef = useRef<Cip30Api | null>(null);
  // Monotonic id for every context fetch, including the submit-time refetch.
  const contextRequestIdRef = useRef(0);
  // Monotonic id for every balance read, see readBalance.
  const balanceReadIdRef = useRef(0);

  const metadata = state.metadata;
  // Destructured for the draft effect below, which reads exactly these five
  // and must not re-run on a context transition.
  const { type, panels, dirty, linkedDraftSlug } = state;
  const contextual = needsContext(state.type);

  /**
   * Fetches the live ledger context for a type and files the outcome through
   * the reducer. Used both by the mount/type-change effect and by the
   * submit-time refetch, so the request-id bookkeeping is written once.
   *
   * Nothing to cancel: every request carries an id and the reducer ignores a
   * loaded or failed response whose id is no longer the latest, so a response
   * that arrives after a type switch is already a no-op.
   */
  const loadContext = useCallback(async (forType: GovActionFormType): Promise<ActionContextResponse | null> => {
    contextRequestIdRef.current += 1;
    const requestId = contextRequestIdRef.current;
    dispatch({ kind: 'contextRequested', requestId });
    try {
      const res = await fetchWithTimeout(
        `${window.location.origin}/api/gov-action/context?type=${encodeURIComponent(forType)}`,
      );
      if (!res.ok) {
        // The route words one failure on its own: a guardrail nothing on chain
        // proves, which the panel explains differently from an outage.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        dispatch({ kind: 'contextFailed', requestId, code: body?.error });
        return null;
      }
      const data = (await res.json()) as ActionContextResponse;
      dispatch({ kind: 'contextLoaded', requestId, data, now: Date.now() });
      return data;
    } catch {
      dispatch({ kind: 'contextFailed', requestId });
      return null;
    }
  }, []);

  // Draft persistence: restore runs once after mount (no localStorage during
  // SSR), the persist effect stays quiet until then so it can never clobber a
  // stored draft with the pre-restore empty state. Mirrors VotePanel's
  // draftRestoredRef pattern. Never persists wallet data, addresses,
  // signatures, the deposit, or the tx result: only the plain form fields and
  // the per-type panel state.
  const draftKey = govActionDraftKey(network);
  const draftRestoredRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: openDrafts, draftSiteOrigin and network are the page's own SSR props, fixed for the session, restore runs once right after mount regardless
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const draft = loadGovActionDraft(window.localStorage, draftKey);
    if (draft) {
      // A draft saved for a type this network does not offer (a treasury
      // withdrawal draft on mainnet) restores as an info action, panels kept.
      const available = govActionTypeAvailable(draft.type, {
        submissionAvailable: govActionSubmissionAvailable(network),
        network,
      });
      const restorable = available ? draft : { ...draft, type: 'InfoAction' as const };
      dispatch({ kind: 'restoreDraft', draft: restorable, openDrafts, siteOrigin: draftSiteOrigin });
      setRestoredAt(draft.savedAt ?? null);
    }
    draftRestoredRef.current = true;
  }, [draftKey]);
  useEffect(() => {
    // Saving only while dirty is what keeps a fresh visit from writing a
    // draft at all: the prefilled author name and default signing-on would
    // otherwise look like something worth storing the moment localStorage
    // becomes available.
    if (typeof window === 'undefined' || !draftRestoredRef.current || !dirty) return;
    // A draft is only worth keeping while it carries something: metadata text,
    // a non-default type, or a filled panel. A committee panel with no
    // metadata yet is kept, which is why the check is not metadata-only.
    const draftable = { metadata, type, panels, linkedDraftSlug };
    if (isFormBlank(draftable, { authorName: displayName })) clearGovActionDraft(window.localStorage, draftKey);
    else saveGovActionDraft(window.localStorage, draftKey, draftFromState(draftable));
  }, [draftKey, metadata, type, panels, linkedDraftSlug, dirty, displayName]);

  /**
   * Discards the restored/in-progress draft: back to the defaults, storage
   * cleared, banner gone. Refused while a submit is running: that handler is
   * still reading the very fields this would empty, and the banner's button is
   * disabled then anyway, so this is the guard behind it rather than the only
   * one.
   */
  function handleDiscardDraft() {
    if (phase.status === 'submitting') return;
    dispatch({ kind: 'discardDraft', displayName });
    if (typeof window !== 'undefined') clearGovActionDraft(window.localStorage, draftKey);
    setRestoredAt(undefined);
  }

  // Deposit and voting thresholds are informational chain data, independent of
  // the wallet connection, and one /epoch_params read serves both.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(`${window.location.origin}/api/koios/epoch_params?limit=1`);
        if (!res.ok) throw new Error(`epoch_params request failed (${res.status})`);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const row = rows[0];
        const lovelace = parseDepositLovelace(row?.gov_action_deposit);
        if (lovelace === null) throw new Error('gov_action_deposit missing from response');
        if (!cancelled) {
          setDeposit({ status: 'ready', lovelace });
          setEpochParamsRow(row as EpochParamsRow);
        }
      } catch {
        if (!cancelled) {
          setDeposit({
            status: 'error',
            message: 'Could not load the current governance action deposit. Please reload the page.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live ledger context for the chosen type: the purpose chain's root and open
  // rows, plus whatever the type's panel needs. InfoAction is unchained and
  // needs none, so it costs no request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contextAttempt is the retry nonce, it exists to re-run this effect for the same type
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!needsContext(state.type)) return;
    void loadContext(state.type);
  }, [state.type, contextAttempt, loadContext]);

  // Reload-safe: a tab left open and switched away from can sit long enough
  // for the chain to move under it, so a return to visibility after more
  // than a minute hidden refetches the current type's context, exactly like
  // the retry button does. Under a minute is not worth a request: a quick
  // tab switch should not cost one every time. InfoAction has no context to
  // refetch.
  //
  // Never while a submit is running: handleSubmit sets phase to 'submitting'
  // synchronously before it does its OWN freshness refetch, and that refetch
  // is what handleSubmit validates and builds the action against. A
  // background refetch racing it would bump the request id the reducer
  // tracks, and although the reducer itself ignores whichever response comes
  // back on a superseded id, `loadContext` still hands its (by then stale)
  // response straight back to its caller. handleSubmit would use that
  // returned reading even though the panel on screen has already moved on to
  // whatever the OTHER request answered with. Gating on the phase, checked
  // through a ref so this closure sees it live, closes that window: it
  // covers the whole submit, not just the moment the freshness fetch is
  // actually in flight.
  const hiddenAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    function handleVisibilityChange() {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (hiddenAt === null) return;
      if (Date.now() - hiddenAt <= 60_000) return;
      if (phaseRef.current.status === 'submitting') return;
      if (!needsContext(state.type)) return;
      void loadContext(state.type);
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [state.type, loadContext]);

  // The treasury recipients' registration: one batched account_info read for
  // every row whose address parses, after an edit (debounced), after a draft
  // restore (the rows change) and on "Try again". The set of addresses is the
  // key, so an amount edit costs no request. Every check is marked as running
  // at once under a fresh id, so an answer still in flight for the previous
  // set is dropped by the reducer. The addresses are the normalized lowercase
  // bech32 parseStakeAddress returns, the form validateTreasuryPanel looks
  // them up by.
  const recipientsRequestIdRef = useRef(0);
  const [recipientsAttempt, setRecipientsAttempt] = useState(0);

  /**
   * Starts one registration check: a fresh request id, and every address
   * marked as checking under it at once. Returns the read itself, which files
   * the answer (or the failure) under that id and resolves to the answer, or
   * to null when the lookup failed. Split in two so the debounced effect can
   * mark the set as checking right away and still cancel the read.
   */
  const startRecipientsCheck = useCallback((addresses: readonly string[]) => {
    recipientsRequestIdRef.current += 1;
    const requestId = recipientsRequestIdRef.current;
    dispatch({ kind: 'recipientsCheckRequested', requestId, addresses });
    return async (): Promise<Map<string, boolean> | null> => {
      try {
        const registered = await fetchStakeRegistrations({ stakeAddresses: addresses, origin: window.location.origin });
        dispatch({ kind: 'recipientsChecked', requestId, registered: Object.fromEntries(registered) });
        return registered;
      } catch {
        dispatch({ kind: 'recipientsCheckFailed', requestId });
        return null;
      }
    };
  }, []);
  const recipientKey = useMemo(() => {
    if (state.type !== 'TreasuryWithdrawals') return '';
    return checkTreasuryRows(state.panels.TreasuryWithdrawals.rows, network)
      .rows.flatMap((row) => (row.address ? [row.address.stakeAddress] : []))
      .join(',');
  }, [state.type, state.panels.TreasuryWithdrawals, network]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recipientsAttempt is the retry nonce, it exists to re-run this effect for the same addresses
  useEffect(() => {
    if (typeof window === 'undefined' || recipientKey === '') return;
    const readRegistrations = startRecipientsCheck(recipientKey.split(','));
    const timer = setTimeout(() => void readRegistrations(), RECIPIENT_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [recipientKey, recipientsAttempt, startRecipientsCheck]);

  /**
   * Reads every recipient's registration again right before the author
   * signature and the pins. The answer goes through the reducer too, so the
   * panel shows what was found. Returns the sentence that blocks the submit,
   * or null when every recipient is registered.
   */
  async function recheckRecipients(): Promise<string | null> {
    const checked = checkTreasuryRows(state.panels.TreasuryWithdrawals.rows, network);
    if (!checked.ok) return checked.error;
    const addresses = checked.withdrawals.map((w) => w.recipient.stakeAddress);
    const registered = await startRecipientsCheck(addresses)();
    if (!registered) return RECIPIENTS_CHECK_FAILED_AT_SUBMIT;
    return addresses.every((address) => registered.get(address) === true) ? null : RECIPIENT_UNREGISTERED;
  }

  // Ticks once a minute so the "loaded n minutes ago" line stays current on
  // a page nobody touches, without a refetch. Cleared on unmount.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  /**
   * "Chain context loaded n minutes ago", once the reading is at least ten
   * minutes old, else null. Reads `loadedAt` rather than gating on the ready
   * status, so the line keeps showing (and keeps its own age) through a
   * same-type refetch that is still in flight, exactly like the context data
   * it is about.
   */
  function contextAgeLine(): string | null {
    if (state.context.loadedAt === null) return null;
    const minutes = Math.floor((nowMs - state.context.loadedAt) / 60_000);
    if (minutes < 10) return null;
    return `Chain context loaded ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  // Only the submit step freezes the form now. Connecting a wallet does not:
  // it happens in the last section while everything above stays editable.
  const busy = phase.status === 'submitting';
  // Same parser the server uses, so the form can never accept a ref the
  // server would reject (or the other way round).
  const surveyRefState = metadata.surveyRef.trim() ? parseSurveyRefInput(metadata.surveyRef) : null;
  const contextReady = state.context.status === 'ready' && state.context.data !== null;
  const contextData = state.context.data;

  // The current type's panel verdict for the readiness list (see
  // panelReadiness for the per-type rules). Memoized because the committee
  // arm validates every typed row, which is more work than a re-render of an
  // unrelated field should cost.
  // What the treasury panel is judged by besides the context, one object for
  // the readiness list and the submit-time validation alike.
  const treasuryEnv = useMemo(() => ({ network, recipients: state.recipients }), [network, state.recipients]);
  const panelValidation = useMemo(
    () => panelReadiness(state.type, state.panels, contextData, treasuryEnv),
    [state.type, state.panels, contextData, treasuryEnv],
  );

  // Everything standing between the form as it is and a submittable proposal.
  // The same list drives the button's disabled state, so a grey button always
  // has its reasons on screen next to it.
  const reasons = readinessReasons({
    type: state.type,
    contextStatus: state.context.status,
    panelValidation,
    metadataComplete: Boolean(
      metadata.title.trim() && metadata.abstract.trim() && metadata.motivation.trim() && metadata.rationale.trim(),
    ),
    authorOk: !metadata.signAsAuthor || metadata.authorName.trim() !== '',
    surveyRefOk: surveyRefState === null || surveyRefState.ok,
    draftConflict: draftConflict(state, openDrafts, draftSiteOrigin),
    wallet: state.wallet,
    depositLovelace: deposit.status === 'ready' ? deposit.lovelace : null,
  });

  // ------------------------------------------------------------------
  // Review: the action as the action page will render it, built entirely
  // from what is on screen (the form, the displayed context, the epoch
  // params), so untouched defaults resolve exactly as the panels resolve
  // them. Only the Markdown goes to the server, once, from inside the modal.
  //
  // Built only while the modal is open: a NewConstitution preview hashes the
  // whole document (up to 256 KiB), which is not something to redo on every
  // keystroke of a form that is closed over it.
  // ------------------------------------------------------------------
  const preview = useMemo(
    () => (reviewOpen ? previewModelFromForm(state, contextData, epochParamsRow, network) : null),
    [reviewOpen, state, contextData, epochParamsRow, network],
  );
  // Names for the on-chain card's committee rows. Keyed lowercase because that
  // is the case the decoder hands back (the panel lowercases every credential
  // before it reaches the payload), and the context may well carry it mixed.
  // Same source the panel's own labels come from.
  const committeeNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of contextData?.committee?.members ?? []) {
      if (member.coldHex && member.name) names.set(member.coldHex.toLowerCase(), member.name);
    }
    return names;
  }, [contextData]);

  // Focus goes back to the Review button only after the dialog has actually
  // closed. Calling focus() from the close handler would be a no-op: the
  // dialog is still shown modally at that point, so the rest of the document
  // is inert and the call is dropped. Child effects run before this one, so
  // ReviewModal's own effect has already called dialog.close() by the time
  // this fires. The browser's own focus restoration is the fallback, which on
  // Safari would return focus to whatever was focused before the click, not the
  // button, since a button click there does not focus the button.
  const reviewWasOpen = useRef(false);
  useEffect(() => {
    if (reviewWasOpen.current && !reviewOpen) reviewButtonRef.current?.focus();
    reviewWasOpen.current = reviewOpen;
  }, [reviewOpen]);

  // ------------------------------------------------------------------
  // References row editor (optional, like GovTool's reference links).
  // ------------------------------------------------------------------
  function setMetadata(patch: Partial<typeof metadata>) {
    // siteOrigin is only read by the reducer when patch carries a new
    // references array (see govActionFormState.ts), so passing it on every
    // call is harmless for the title/abstract/author/etc. edits.
    dispatch({ kind: 'setMetadata', patch, siteOrigin: draftSiteOrigin });
  }
  function updateReference(i: number, patch: { label?: string; uri?: string }) {
    setMetadata({ references: metadata.references.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  }
  function removeReference(i: number) {
    setMetadata({ references: metadata.references.filter((_, idx) => idx !== i) });
  }
  function addReference() {
    if (metadata.references.length >= REFERENCES_MAX) return;
    setMetadata({ references: [...metadata.references, { label: '', uri: '' }] });
  }

  // ------------------------------------------------------------------
  // Proposal Draft link, directly above the references list: see
  // govActionFormState.ts's linkDraft/unlinkDraft for the replace-at-the-front
  // and append-at-cap rules.
  // ------------------------------------------------------------------
  const linkedDraftRef = linkedDraftReference(state, draftSiteOrigin);
  // What the select shows as chosen: the tracked slug, or, when nothing is
  // tracked, the first reference that names an open draft (a hand-typed or
  // hand-edited URL the control never added). Passed back into both actions so
  // they replace or remove the row the control is showing, rather than only
  // ever the one it added itself.
  const selectedDraftSlug = effectiveLinkedDraftSlug(state, openDrafts, draftSiteOrigin);
  function handleLinkDraft(pick: { slug: string; title: string }) {
    dispatch({
      kind: 'linkDraft',
      slug: pick.slug,
      title: pick.title,
      siteOrigin: draftSiteOrigin,
      selectedSlug: selectedDraftSlug,
    });
  }
  function handleUnlinkDraft() {
    dispatch({ kind: 'unlinkDraft', siteOrigin: draftSiteOrigin, selectedSlug: selectedDraftSlug });
  }

  /**
   * Validates the panel against a context and returns what the action needs,
   * as an error string rather than a throw so the submit handler can surface
   * it like any other validation failure. Called with the FRESH context at
   * submit time, so an epoch or a protocol version that moved while the form
   * was open is caught here, and (for the panel preview) with the displayed
   * one.
   */
  function prepareAction(
    ctx: ActionContextResponse | null,
    prev: PrevActionRef | null,
  ):
    | { ok: false; error: string }
    | { ok: true; spec: GovActionSpec }
    // The constitution document has to be published before its hash can go
    // into the action, so this arm carries the text instead of a finished spec.
    | { ok: true; constitution: { text: string; scriptHashHex: string | null; prev: PrevActionRef | null } } {
    switch (state.type) {
      case 'InfoAction':
        return { ok: true, spec: { type: 'InfoAction' } };

      case 'NoConfidence':
        return { ok: true, spec: { type: 'NoConfidence', prev } };

      case 'HardForkInitiation': {
        const result = validateHardForkPanel({ ...state.panels.HardForkInitiation, prev }, ctx);
        if (!result.ok) return result;
        return { ok: true, spec: { type: 'HardForkInitiation', prev, version: result.value } };
      }

      case 'NewConstitution': {
        const result = validateNewConstitutionPanel({ ...state.panels.NewConstitution, prev }, ctx);
        if (!result.ok) return result;
        return { ok: true, constitution: { ...result.value, prev } };
      }

      case 'UpdateCommittee': {
        const result = validateCommitteePanel({ ...state.panels.UpdateCommittee, prev }, ctx);
        if (!result.value) {
          return { ok: false, error: result.errors[0]?.message ?? 'The committee update is not valid yet.' };
        }
        return {
          ok: true,
          spec: {
            type: 'UpdateCommittee',
            prev,
            remove: result.value.remove,
            add: result.value.add,
            quorum: result.value.quorum,
          },
        };
      }

      case 'TreasuryWithdrawals': {
        const result = validateTreasuryPanel(state.panels.TreasuryWithdrawals, ctx, treasuryEnv);
        if (!result.ok) return result;
        return {
          ok: true,
          spec: {
            type: 'TreasuryWithdrawals',
            withdrawals: result.value.withdrawals.map((w) => ({
              rewardAddressHex: w.recipient.rewardAddressHex,
              lovelace: w.lovelace,
            })),
            guardrail: result.value.guardrail,
          },
        };
      }
    }
  }

  // ------------------------------------------------------------------
  // The wallet step, at the END of the form: connect, run the network guard,
  // read the reward address, then read the funding balance. Plain CIP-30
  // enable, no CIP-95 extension: submitting a proposal needs no DRep key.
  // ------------------------------------------------------------------

  /**
   * Reads the wallet's funding balance with exactly the collector the
   * transaction builder uses, so the readiness check and the builder cannot
   * disagree about what the wallet holds, and whether the reward address is
   * a registered stake account the deposit can be refunded to. Also the
   * "Check again" handler, which is why it takes the api and the address
   * rather than reading state: after a top-up or a registration nothing else
   * has changed.
   */
  async function readBalance(api: Cip30Api, rewardAddressHex: string) {
    // Every read carries a generation and only the latest one may file its
    // answer. "Use a different wallet" during a slow read, and a second
    // "Check again" before the first came back, both leave an older read in
    // flight, while the reducer's own guard only knows that SOME wallet is
    // connected. Comparing the api object instead would not do: reconnecting
    // the same extension hands back the same object.
    balanceReadIdRef.current += 1;
    const readId = balanceReadIdRef.current;
    dispatch({ kind: 'walletBalanceLoading' });
    try {
      // The refund address check rides along with the balance read, so
      // "Check again" after registering the stake key re-reads both. A failed
      // lookup leaves it unknown rather than blocking the submit.
      const [utxos, rewardRegistered] = await Promise.all([
        collectWalletUtxos(network, window.location.origin, api as unknown as WalletApi),
        fetchStakeRegistration({ rewardAddressHex, network, origin: window.location.origin })
          .then((r) => r.registered)
          .catch(() => undefined),
      ]);
      if (balanceReadIdRef.current !== readId) return;
      dispatch({ kind: 'walletBalance', lovelace: totalLovelace(utxos), rewardRegistered });
    } catch (err) {
      if (balanceReadIdRef.current !== readId) return;
      dispatch({ kind: 'walletBalanceFailed', message: readableError(err) });
    }
  }

  function handleCheckAgain() {
    const api = enabledApiRef.current;
    if (!api || state.wallet.status !== 'connected') return;
    void readBalance(api, state.wallet.rewardAddressHex);
  }

  async function handleConnect(): Promise<boolean> {
    // A second click while the first connect is still running does nothing:
    // the wallet is already showing its prompt.
    if (state.wallet.status === 'connecting') return false;
    const walletInfo = wallets.find((w) => w.key === selected);
    if (!walletInfo) return false;

    /**
     * Back to no wallet, with the message next to the Connect button. Takes
     * either a thrown value or a ready-made sentence, since one of the four
     * failures here is our own rule rather than a wallet error.
     */
    function failed(err: unknown) {
      dispatch({ kind: 'walletDisconnected' });
      setPhase({
        status: 'error',
        message: typeof err === 'string' ? err : readableError(err),
        step: 'connect',
      });
    }

    setPhase({ status: 'editing' });
    dispatch({ kind: 'walletConnecting' });

    let api: Cip30Api;
    try {
      api = (await walletInfo.raw.enable()) as unknown as Cip30Api;
    } catch (err) {
      failed(err);
      return false;
    }

    // Fail clearly before any tx is built when the wallet is on the wrong
    // network (e.g. Mainnet instead of Preprod).
    try {
      await assertWalletNetwork(api, network);
    } catch (err) {
      failed(err);
      return false;
    }

    // The reward address is required regardless of author signing: it is
    // where the deposit refund goes, and (when signing) the address the
    // CIP-108 witness proves ownership of. Read at connect time so a wallet
    // that cannot provide one is rejected before anything is filled in
    // against it.
    let rewardAddressHex: string | undefined;
    try {
      rewardAddressHex = (await api.getRewardAddresses())[0];
    } catch (err) {
      failed(err);
      return false;
    }
    if (!rewardAddressHex) {
      failed(
        'Your wallet exposes no reward address, so it cannot receive the deposit refund. Please use a different wallet.',
      );
      return false;
    }

    enabledApiRef.current = api;
    rememberWallet(selected);
    dispatch({ kind: 'walletConnected', rewardAddressHex });
    void readBalance(api, rewardAddressHex);
    return true;
  }

  /**
   * The recipient panel's connect button. One wallet, or one the user already
   * chose or used last time, connects right away and the address is added once
   * it is known. With several wallets and no choice yet, the picker is brought
   * into view instead and nothing is connected.
   */
  async function handleConnectAndAddOwn() {
    if (state.wallet.status !== 'none') return;
    const decided = wallets.length === 1 || walletPickedRef.current || (selected !== '' && selected === recallWallet());
    if (!decided) {
      setFocusPickerToken((n) => n + 1);
      return;
    }
    addOwnAfterConnectRef.current = true;
    const ok = await handleConnect();
    if (!ok) addOwnAfterConnectRef.current = false;
  }

  // ------------------------------------------------------------------
  // Submit. Prepare + sign the author witness (if toggled), host the
  // metadata, then build/sign/submit the propose tx. The reward address comes
  // from the state it was put into at connect time, the api from the ref.
  // ------------------------------------------------------------------
  /**
   * The dialog's Sign and submit. The fields sit inert behind the modal, so a
   * field the browser rejects (the reference URLs have rules of their own) is
   * reported only after the dialog is closed, where it can take focus.
   */
  function confirmSubmit() {
    const form = formRef.current;
    if (form && !form.checkValidity()) {
      flushSync(() => setReviewOpen(false));
      form.reportValidity();
      return;
    }
    setReviewOpen(false);
    void handleSubmit();
  }

  async function handleSubmit() {
    // The readiness list is the single gate: it already names every missing
    // piece on screen, and the review's Sign and submit is disabled while it
    // has any, so this only backs that button up.
    if (phase.status === 'submitting' || reasons.length > 0) return;

    const api = enabledApiRef.current;
    const rewardAddressHex = state.wallet.status === 'connected' ? state.wallet.rewardAddressHex : null;
    if (!api || !rewardAddressHex) {
      dispatch({ kind: 'walletDisconnected' });
      setPhase({ status: 'error', message: 'Wallet connection was lost. Please reconnect.', step: 'connect' });
      return;
    }
    if (deposit.status !== 'ready') {
      setPhase({
        status: 'error',
        message: 'The current deposit amount has not finished loading. Please wait a moment and try again.',
        step: 'submit',
      });
      return;
    }
    if (contextual && !contextReady) {
      setPhase({
        status: 'error',
        message: 'The current chain state has not finished loading. Please wait a moment and try again.',
        step: 'submit',
      });
      return;
    }

    const fields: InfoActionFields = {
      title: metadata.title.trim(),
      abstract: metadata.abstract.trim(),
      motivation: metadata.motivation.trim(),
      rationale: metadata.rationale.trim(),
    };
    if (!fields.title || !fields.abstract || !fields.motivation || !fields.rationale) {
      setPhase({ status: 'error', message: 'Please fill in every field.', step: 'submit' });
      return;
    }
    const trimmedAuthorName = metadata.authorName.trim();
    if (metadata.signAsAuthor && !trimmedAuthorName) {
      setPhase({ status: 'error', message: 'Enter a name to sign as the author, or turn off "Sign as author".', step: 'submit' });
      return;
    }

    // Resolved against the context the user actually saw, so the freshness
    // check below compares like for like: a chain root that moved in the
    // meantime is a change, not something to follow silently.
    const prev = effectivePrev(chosenPrev(state.type, state.panels), contextData);

    // Trimmed, non-empty rows only. Sent identically to both the prepare and
    // finalize calls below so the hash the wallet signs matches what is
    // finally anchored.
    const referencePayload = metadata.references
      .map((r) => ({ label: r.label.trim(), uri: r.uri.trim() }))
      .filter((r) => r.label && r.uri);
    // Only include the references key when there is at least one, so the served
    // doc stays byte-identical to the no-references case (the builder omits it too).
    const referencesField = referencePayload.length > 0 ? { references: referencePayload } : {};
    // Sent raw: the server re-parses with the same rules and is authoritative.
    const surveyField = metadata.surveyRef.trim() ? { surveyRef: metadata.surveyRef.trim() } : {};

    setPhase({ status: 'submitting' });

    try {
      // The account behind an enabled CIP-30 handle is not fixed: switching
      // accounts in the extension keeps the same api object but changes both
      // the UTxOs the builder collects and the reward address the deposit is
      // refunded to. The address read at connect time is what this submit
      // would anchor and (when signing as author) prove ownership of, so it is
      // re-read and compared before anything is published. A mismatch, or a
      // wallet that suddenly exposes no reward address at all, drops the
      // connection rather than submitting against two different accounts.
      let currentRewardAddressHex: string | undefined;
      try {
        currentRewardAddressHex = (await api.getRewardAddresses())[0];
      } catch {
        currentRewardAddressHex = undefined;
      }
      if (!currentRewardAddressHex || currentRewardAddressHex.toLowerCase() !== rewardAddressHex.toLowerCase()) {
        enabledApiRef.current = null;
        // Anything still in flight belongs to the account that is being dropped.
        balanceReadIdRef.current += 1;
        dispatch({ kind: 'walletDisconnected' });
        setPhase({ status: 'error', message: WALLET_ACCOUNT_CHANGED, step: 'connect' });
        return;
      }

      // The chain can move between filling the form and pressing submit, and a
      // proposal chained onto a vanished previous action is rejected by the
      // node after the deposit prompt. Check first, before anything is
      // published or signed.
      let fresh: ActionContextResponse | null = contextData;
      if (contextual) {
        // The route answers no-store, so this cannot come from the browser
        // cache. The fresh response replaces the stored one either way, so
        // the panel immediately shows what the chain looks like now. A
        // treasury withdrawal reads its recipients' registration again at the
        // same time, the two reads do not depend on each other.
        const [loaded, recipientsProblem] = await Promise.all([
          loadContext(state.type),
          // Must stay before prepareAction below: prepareAction reads
          // state.recipients from this click's closure, and only this recheck
          // guarantees every recipient is registered right now.
          state.type === 'TreasuryWithdrawals' ? recheckRecipients() : Promise.resolve(null),
        ]);
        fresh = loaded;
        const problem = preSignatureProblem(state.type, prev, fresh, recipientsProblem);
        if (problem) {
          setPhase({ status: 'error', message: problem, step: 'submit' });
          return;
        }
      }

      // The panel is validated against the fresh context too: an expiry epoch
      // or a protocol version that was fine when it was typed can be stale by
      // now, and the ledger would reject the proposal after the deposit.
      const prepared = prepareAction(fresh, prev);
      if (!prepared.ok) {
        setPhase({ status: 'error', message: prepared.error, step: 'submit' });
        return;
      }

      // The constitution document is published first, so a failed pin aborts
      // before the proposal metadata is published or anything is signed.
      let spec: GovActionSpec;
      if ('constitution' in prepared) {
        const docRes = await fetchWithTimeout(`${window.location.origin}/api/gov-action/document`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: prepared.constitution.text }),
        });
        if (!docRes.ok) {
          const body = (await docRes.json().catch(() => null)) as { error?: string } | null;
          setPhase({
            status: 'error',
            message: body?.error
              ? `Could not publish the constitution document: ${body.error}.`
              : 'Could not publish the constitution document. Nothing else was published, please try again.',
            step: 'submit',
          });
          return;
        }
        const doc = (await docRes.json()) as { url: string; hashHex: string };
        spec = {
          type: 'NewConstitution',
          prev: prepared.constitution.prev,
          anchorUrl: doc.url,
          anchorHashHex: doc.hashHex,
          scriptHashHex: prepared.constitution.scriptHashHex,
        };
      } else {
        spec = prepared.spec;
      }

      let author: { name: string; keyHex: string; signatureHex: string } | undefined;
      if (metadata.signAsAuthor) {
        const prepareRes = await fetchWithTimeout(`${window.location.origin}/api/gov-action/metadata/prepare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...fields, ...referencesField, ...surveyField }),
        });
        if (!prepareRes.ok) {
          const body = (await prepareRes.json().catch(() => null)) as { error?: string } | null;
          setPhase({
            status: 'error',
            message: body?.error
              ? `Could not prepare the metadata for signing: ${body.error}.`
              : 'Could not prepare the metadata for signing. Please try again.',
            step: 'submit',
          });
          return;
        }
        const { bodyHash } = (await prepareRes.json()) as { bodyHash: string };

        // bodyHash is already the hex encoding of the 32 raw bytes to sign;
        // pass it straight through as the CIP-30 Bytes argument. Do not
        // re-encode it as a UTF-8 string first.
        let sig: DataSignature;
        try {
          sig = await api.signData(rewardAddressHex, bodyHash);
        } catch (err) {
          setPhase({ status: 'error', message: readableError(err), step: 'submit' });
          return;
        }
        author = { name: trimmedAuthorName, keyHex: sig.key, signatureHex: sig.signature };
      }

      const metaRes = await fetchWithTimeout(`${window.location.origin}/api/gov-action/metadata`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          ...(author ? { author } : {}),
          ...referencesField,
          ...surveyField,
        }),
      });
      if (!metaRes.ok) {
        const body = (await metaRes.json().catch(() => null)) as { error?: string } | null;
        setPhase({
          status: 'error',
          message: body?.error ? `Could not host the metadata: ${body.error}.` : 'Could not host the metadata. Please try again.',
          step: 'submit',
        });
        return;
      }
      const { anchorUrl, anchorHash } = (await metaRes.json()) as { anchorUrl: string; anchorHash: string };

      // The wallet builds, signs (deposit + fee shown here), and submits.
      // The double cast is forced by the SDK's wrong signData return type (see
      // DataSignature above), not by a real difference: every other method
      // matches. It is safe because nothing in the submit path calls signData,
      // so the field the SDK invents is never read. Drop the cast if the SDK
      // ever corrects that type.
      const { txHash } = await submitGovAction({
        walletApi: api as unknown as WalletApi,
        network,
        origin: window.location.origin,
        rewardAddressHex,
        anchorUrl,
        anchorHashHex: anchorHash,
        govActionDepositLovelace: deposit.lovelace,
        action: spec,
      });

      // The proposal is on chain: drop the draft eagerly so a crash right
      // after success cannot resurrect the already-submitted form text.
      if (typeof window !== 'undefined') clearGovActionDraft(window.localStorage, draftKey);
      // The submit path above builds exactly one proposal per transaction, so
      // the on-chain action id (the governance_actions.id form the status
      // route and the sync both key on) is always this tx hash at index 0.
      setPhase({ status: 'success', txHash, authored: metadata.signAsAuthor, refundEpoch: latestRefundEpoch(epochParamsRow) });
    } catch (err) {
      setPhase({ status: 'error', ...mapSubmitError(err, prev), step: 'submit' });
    }
  }

  /**
   * "Use a different wallet": drops the enabled api, the reward address and
   * the balance, and clears the error. The form itself is untouched, which is
   * the point of the wallet living at the end of it.
   */
  function reset() {
    enabledApiRef.current = null;
    // Anything still in flight for the wallet being dropped is now stale.
    balanceReadIdRef.current += 1;
    dispatch({ kind: 'walletDisconnected' });
    setPhase({ status: 'editing' });
  }

  // The success screen's own poll: once submitted, ask the status route
  // every 30 s for up to 10 minutes until gov-sync has opened the thread (see
  // successPolling.ts for the schedule itself). Kept as a plain tx hash
  // dependency so the effect only restarts on an actual new submission, never
  // on an unrelated re-render while already on the success screen.
  const successTxHash = phase.status === 'success' ? phase.txHash : null;
  const [pollState, setPollState] = useState<SuccessPollState>({ kind: 'pending' });
  useEffect(() => {
    if (successTxHash === null) return;
    setPollState({ kind: 'pending' });
    const id = `${successTxHash}#0`;
    const cancel = startStatusPolling({
      fetchStatus: async (): Promise<GovActionStatusResponse | null> => {
        const res = await fetchWithTimeout(
          `${window.location.origin}/api/gov-action/status?id=${encodeURIComponent(id)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return null;
        return (await res.json()) as GovActionStatusResponse;
      },
      onUpdate: setPollState,
    });
    return cancel;
  }, [successTxHash]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  /** The type panel, plus the context's own loading and error rows. */
  function renderPanel() {
    if (!contextual) return null;
    if (state.context.status === 'error') {
      return (
        <div className="callout callout--error" role="alert">
          <ErrorIcon />
          <div className="callout__body">
            {CONTEXT_ERROR_MESSAGES.get(state.context.code ?? '') ??
              'Could not load the current chain state for this action type.'}{' '}
            <button
              type="button"
              onClick={() => setContextAttempt((n) => n + 1)}
              style={linkButtonStyle}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    if (!contextData) {
      return <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>Loading the current chain state...</p>;
    }
    const prevContext = contextData.prev ?? { lastEnacted: null, open: [] };
    switch (state.type) {
      case 'NoConfidence':
        return (
          <PrevActionField
            context={prevContext}
            value={state.panels.NoConfidence.prev}
            onChange={(prev) => dispatch({ kind: 'setPanel', type: 'NoConfidence', state: { prev } })}
            networkConfig={networkConfig}
            disabled={busy}
          />
        );
      case 'HardForkInitiation':
        return (
          <HardForkPanel
            context={contextData}
            value={state.panels.HardForkInitiation}
            onChange={(panel) => dispatch({ kind: 'setPanel', type: 'HardForkInitiation', state: panel })}
            networkConfig={networkConfig}
            disabled={busy}
          />
        );
      case 'NewConstitution':
        return (
          <NewConstitutionPanel
            context={contextData}
            value={state.panels.NewConstitution}
            onChange={(panel) => dispatch({ kind: 'setPanel', type: 'NewConstitution', state: panel })}
            networkConfig={networkConfig}
            disabled={busy}
          />
        );
      case 'UpdateCommittee':
        return (
          <UpdateCommitteePanel
            context={contextData}
            value={state.panels.UpdateCommittee}
            onChange={(panel) => dispatch({ kind: 'setPanel', type: 'UpdateCommittee', state: panel })}
            networkConfig={networkConfig}
            disabled={busy}
          />
        );
      case 'TreasuryWithdrawals':
        return (
          <TreasuryPanel
            value={state.panels.TreasuryWithdrawals}
            onChange={(panel) => dispatch({ kind: 'setPanel', type: 'TreasuryWithdrawals', state: panel })}
            network={network}
            guardrail={contextData.guardrail}
            recipients={state.recipients}
            onRetryRecipients={() => setRecipientsAttempt((n) => n + 1)}
            ownStakeAddress={ownStakeAddress}
            canConnectWallet={wallets.length > 0 && state.wallet.status === 'none'}
            onConnectAndAddOwn={() => void handleConnectAndAddOwn()}
            disabled={busy}
          />
        );
      default:
        return null;
    }
  }

  // The wallet's own stake address for the treasury panel's shortcut button.
  let ownStakeAddress: string | null = null;
  if (state.wallet.status === 'connected') {
    try {
      ownStakeAddress = rewardAddressToStakeBech32(state.wallet.rewardAddressHex, network);
    } catch {
      ownStakeAddress = null;
    }
  }

  // Finishes the recipient panel's connect button: reads the panel as it is
  // now (the user may have typed while the wallet prompt was open), not as it
  // was at the click.
  useEffect(() => {
    if (!addOwnAfterConnectRef.current || !ownStakeAddress) return;
    addOwnAfterConnectRef.current = false;
    if (state.type !== 'TreasuryWithdrawals') return;
    const panel = state.panels.TreasuryWithdrawals;
    const rows = withAddressAdded(panel.rows, ownStakeAddress);
    if (rows !== panel.rows) dispatch({ kind: 'setPanel', type: 'TreasuryWithdrawals', state: { rows } });
  }, [ownStakeAddress, state.type, state.panels.TreasuryWithdrawals]);

  // The two context lines above the panel, each computed once rather than in
  // both the guard and the body it guards.
  const ageLine = contextAgeLine();
  const changeLines = contextChangeLines(state.context.changes);

  // Mirrors submitGovAction's own guard: this flow only ever works on
  // preprod, so fail visibly rather than let the user fill out the form and
  // hit the guard only after connecting a wallet.
  if (!govActionSubmissionAvailable(network)) {
    return (
      <div className="callout callout--info" role="status" style={{ maxWidth: '32rem' }}>
        <InfoIcon />
        <div className="callout__body">Submitting a governance action is available on preprod only.</div>
      </div>
    );
  }

  if (phase.status === 'success') {
    return (
      <div style={{ maxWidth: '32rem' }}>
        <div className="callout callout--success" role="status">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Proposal submitted</p>
            <p style={{ margin: '0 0 0.5rem', overflowWrap: 'anywhere' }}>
              Transaction:{' '}
              <a
                href={txExplorerUrl(network, phase.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)', wordBreak: 'break-all' }}
              >
                {phase.txHash}
              </a>
              <CopyButton value={phase.txHash} label="Copy transaction hash" />
            </p>
            {phase.authored && (
              <p style={{ margin: '0 0 0.5rem', color: 'var(--muted)', fontSize: '0.875rem' }}>Signed with wallet key.</p>
            )}
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem' }}>
              The deposit returns to your reward address when the action is enacted
              {phase.refundEpoch !== null ? `, or at the latest at the start of ${epochWithDate(phase.refundEpoch, networkConfig)}` : ' or expires'}
              . {KEEP_STAKE_KEY_REGISTERED}
            </p>
            {pollState.kind === 'pending' && (
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                The action appears in DRepTalk and on explorers only after the next gov-sync run, and after the
                metadata document propagates on the IPFS gateway.
              </p>
            )}
            {pollState.kind === 'synced' && (
              <>
                <p style={{ margin: '0 0 0.35rem' }}>
                  {pollState.slug ? (
                    <a href={`/t/${pollState.slug}/`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
                      Your action is on DRepTalk
                    </a>
                  ) : (
                    <span style={{ fontWeight: 600 }}>Your action is on DRepTalk</span>
                  )}
                </p>
                {pollState.draft && (
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                    Linked to your Proposal Draft{' '}
                    <a href={`/t/${pollState.draft.slug}/`} style={{ color: 'var(--accent)' }}>
                      {pollState.draft.title}
                    </a>
                    , the thread is now locked and the discussion continues on the action page.
                  </p>
                )}
              </>
            )}
            {pollState.kind === 'timed-out' && (
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                Not synced yet, check the{' '}
                <a href="/c/governance-actions/" style={{ color: 'var(--accent)' }}>
                  governance actions list
                </a>
                .
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '40rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {restoredAt !== undefined && (
        <DraftRestoreBanner savedAt={restoredAt} now={Date.now()} onDiscard={handleDiscardDraft} disabled={busy} />
      )}

      <DepositInfo deposit={deposit} />

      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          // Signing starts only from the review's Sign and submit. The form
          // has no submit button, so this is a backstop for anything else
          // that submits it: it opens the review.
          if (!busy) setReviewOpen(true);
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}
      >
        <TypeSelector
          value={state.type}
          onChange={(type) => dispatch({ kind: 'setType', type })}
          params={params}
          deposit={deposit}
          network={network}
          submissionAvailable={govActionSubmissionAvailable(network)}
          disabled={busy}
        />

        {contextual && ageLine && (
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.8125rem' }}>{ageLine}</p>
        )}
        {contextual && changeLines.length > 0 && (
          <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {changeLines.map((line) => (
              <p key={line} style={{ margin: 0, color: 'var(--muted)', fontSize: '0.8125rem' }}>{line}</p>
            ))}
          </div>
        )}

        {renderPanel()}

        <CountedField id="ia-title" label="Title" count={metadata.title.length} max={INFO_TITLE_MAX} help="Short, descriptive title for the proposal.">
          <input
            id="ia-title"
            type="text"
            value={metadata.title}
            onChange={(e) => setMetadata({ title: e.target.value })}
            maxLength={INFO_TITLE_MAX}
            required
            disabled={busy}
            style={inputStyle}
            placeholder="Proposal title"
          />
        </CountedField>

        {MARKDOWN_FIELDS.map((f) => (
          <CountedField key={f.key} id={markdownBodyId(`ia-${f.key}`)} label={f.label} count={metadata[f.key].length} max={f.max} help={f.help}>
            <MarkdownEditor
              idPrefix={`ia-${f.key}`}
              value={metadata[f.key]}
              onChange={(v) => setMetadata({ [f.key]: v })}
              maxLength={f.max}
              minRows={f.rows}
              required
              disabled={busy}
              placeholder={f.placeholder}
              helpText={false}
              mentions={false}
            />
          </CountedField>
        ))}

        <DraftLinkControl
          openDrafts={openDrafts}
          linkedDraftSlug={selectedDraftSlug}
          linkedDraftLabel={linkedDraftRef?.label ?? ''}
          onLink={handleLinkDraft}
          onUnlink={handleUnlinkDraft}
          error={state.draftLinkError}
          disabled={busy}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <span style={labelStyle}>References (optional)</span>
          <span style={helpStyle}>Link to supporting documents or discussions, like GovTool&apos;s reference links.</span>
          {metadata.references.map((ref, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional inputs owned by index, there is no stable id
            <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="text"
                value={ref.label}
                onChange={(e) => updateReference(i, { label: e.target.value })}
                placeholder="Label (e.g. Forum discussion)"
                maxLength={REFERENCE_LABEL_MAX}
                disabled={busy}
                style={{ ...inputStyle, flex: '0 0 12rem' }}
                aria-label={`Reference ${i + 1} label`}
              />
              <input
                type="url"
                value={ref.uri}
                onChange={(e) => updateReference(i, { uri: e.target.value })}
                placeholder="https://..."
                maxLength={REFERENCE_URI_MAX}
                disabled={busy}
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                aria-label={`Reference ${i + 1} URL`}
              />
              <button
                type="button"
                onClick={() => removeReference(i)}
                disabled={busy}
                aria-label={`Remove reference ${i + 1}`}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: busy ? 'not-allowed' : 'pointer', fontSize: '0.8125rem', padding: '0 0.25rem', flexShrink: 0, textDecoration: 'underline' }}
              >
                Remove
              </button>
            </div>
          ))}
          {metadata.references.length < REFERENCES_MAX && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
              <button
                type="button"
                onClick={addReference}
                disabled={busy}
                style={{ background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '0.375rem', padding: '0.375rem 0.75rem', fontSize: '0.875rem', cursor: busy ? 'not-allowed' : 'pointer' }}
              >
                Add reference
              </button>
              <span style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>You can add up to {REFERENCES_MAX} references.</span>
            </div>
          )}
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="ga-survey-ref" style={labelStyle}>Linked CIP-179 survey (optional)</label>
          <p style={{ margin: '0 0 0.375rem', fontSize: '0.8125rem', color: 'var(--muted)' }}>
            Paste the survey reference or a link to it. A survey only gets a thread here once it is
            linked by an imported action, so this is how you link one.
          </p>
          <input
            id="ga-survey-ref"
            type="text"
            value={metadata.surveyRef}
            onChange={(e) => setMetadata({ surveyRef: e.target.value })}
            disabled={busy}
            placeholder="<transaction id>:<index>"
            maxLength={2048}
            style={inputStyle}
          />
          {surveyRefState && (
            <p
              style={{
                margin: '0.375rem 0 0',
                fontSize: '0.8125rem',
                color: surveyRefState.ok ? 'var(--muted)' : 'var(--danger, #b3261e)',
              }}
            >
              {surveyRefState.ok
                ? `Links survey ${surveyRefState.txId.slice(0, 12)}...:${surveyRefState.index}. We have not checked its end epoch or whether it can be admitted.`
                : surveyRefState.reason}
            </p>
          )}
        </div>

        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.875rem' }}>
          <input
            type="checkbox"
            checked={metadata.signAsAuthor}
            onChange={(e) => setMetadata({ signAsAuthor: e.target.checked })}
            disabled={busy}
            style={{ marginTop: '0.15rem' }}
          />
          <span>
            Sign as author
            <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.8125rem', marginTop: '0.15rem' }}>
              Signs the metadata with your wallet&apos;s reward key. The document then shows &quot;Signed with wallet
              key&quot;. The name below is self-declared, not independently verified.
            </span>
          </span>
        </label>

        {metadata.signAsAuthor && (
          <CountedField id="ia-author-name" label="Author name" count={metadata.authorName.length} max={AUTHOR_NAME_MAX} help="Shown alongside the wallet-key signature.">
            <input
              id="ia-author-name"
              type="text"
              value={metadata.authorName}
              onChange={(e) => setMetadata({ authorName: e.target.value })}
              maxLength={AUTHOR_NAME_MAX}
              disabled={busy}
              style={inputStyle}
              placeholder="Your name"
            />
          </CountedField>
        )}

        {/* Order of operations, stated before the button rather than
            discovered at the wallet prompt. The publish step comes first
            because the transaction anchors the document by its hash, so
            the document has to exist to be anchored. That makes the text
            public one step before the user commits on chain, which is the
            part nobody expects, so it is said plainly. */}
        <div className="callout callout--info">
          <div className="callout__body">
            <p style={{ margin: 0 }}>
              <strong>What happens when you submit</strong>
            </p>
            <ol style={{ margin: '0.4rem 0 0', paddingLeft: '1.15rem', fontSize: '0.875rem', lineHeight: 1.5 }}>
              {state.type === 'NewConstitution' && (
                <li>
                  The constitution document is published to IPFS first, so a failed upload stops the flow before
                  anything else is published.
                </li>
              )}
              {metadata.signAsAuthor && (
                <li>Your wallet asks you to sign the metadata. This is the author signature, not a payment.</li>
              )}
              <li>
                The document is published to IPFS, where it is public and permanent. It stays published even if
                you decline the next step.
              </li>
              <li>
                Your wallet asks you to sign the transaction, which locks the
                {deposit.status === 'ready' ? ` ${formatAdaPlain(deposit.lovelace)} tADA ` : ' '}
                deposit and puts the proposal on chain.
              </li>
            </ol>
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.875rem' }}>
              So {metadata.signAsAuthor ? 'there are two wallet prompts, and nothing costs' : 'nothing costs'} ada until
              the last one. Stopping before it leaves the text published with no proposal pointing at it.
            </p>
          </div>
        </div>

        <SignAndSubmit
          wallets={wallets}
          selected={selected}
          onSelect={setSelected}
          wallet={state.wallet}
          deposit={deposit}
          reasons={reasons}
          onConnect={() => void handleConnect()}
          focusPickerToken={focusPickerToken}
          onCheckAgain={handleCheckAgain}
          submitting={busy}
          connectError={phase.status === 'error' && phase.step === 'connect' ? phase.message : null}
          submitError={phase.status === 'error' && phase.step === 'submit' ? phase.message : null}
          submitErrorDetail={phase.status === 'error' && phase.step === 'submit' ? (phase.detail ?? null) : null}
          onUseDifferentWallet={reset}
          onReview={() => setReviewOpen(true)}
          reviewButtonRef={reviewButtonRef}
        />

        <ReviewModal
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          typeLabel={govActionFormTypeLabel(state.type)}
          title={metadata.title}
          abstractMd={metadata.abstract}
          motivationMd={metadata.motivation}
          rationaleMd={metadata.rationale}
          authorLine={preview?.authorLine ?? ''}
          missing={preview?.missing ?? []}
          references={metadata.references}
          onchain={preview?.onchain ?? null}
          committeeNames={committeeNames}
          footer={
            <>
              <ReadinessList reasons={reasons} />
              <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)' }}>{KEEP_STAKE_KEY_REGISTERED}</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={confirmSubmit}
                disabled={busy || reasons.length > 0}
                style={{ alignSelf: 'flex-start' }}
              >
                Sign and submit
              </button>
            </>
          }
        />

        {phase.status === 'submitting' && (
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
            {metadata.signAsAuthor
              ? 'Please approve each wallet prompt. The first signs the metadata, the second sends the transaction.'
              : 'Please review and approve the transaction in your wallet.'}
          </p>
        )}
      </form>
    </div>
  );
}
