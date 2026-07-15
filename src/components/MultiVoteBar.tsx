// React island: batch DRep voting on /vote/. The open-action rows are
// server-rendered by vote.astro with plain [data-mv-choice][data-ga] buttons;
// this island listens via document-level event delegation, owns the selection
// state, mirrors it back onto the row buttons (aria-pressed + .is-active),
// and renders a sticky bottom bar with the review panel and the submit flow.
//
// Submit flow: (1) POST /api/vote/liveness and drop actions that are no
// longer active (a multi-vote tx is all-or-nothing on-chain, one dead action
// invalidates every vote in it), requiring an explicit re-submit when
// anything was dropped; (2) host each unique effective rationale via
// POST /api/vote/rationale; (3) castDRepVotes builds ONE transaction with all
// votes and per-vote anchors, the wallet signs and submits; (4) batch
// POST /api/vote/record mirrors the result optimistically.
import { useEffect, useRef, useState } from 'react';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import { connectAsDrep, type EnabledWalletApi, type DRepIdentity } from '@/lib/wallet/drepWalletConnect.js';
import type { WalletApi as TxWalletApi, CastDRepVotesOpts } from '@/lib/governance/drepTx.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { expiredActionMessage } from '@/components/VotePanel.js';
import WalletConnection from '@/components/WalletConnection.js';
import RationaleModal from '@/components/RationaleModal.js';
import { CopyButton } from '@/components/CopyButton.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import type { CardanoNetwork } from '@/lib/config/network.js';

type VoteChoice = 'yes' | 'no' | 'abstain';

export interface MultiVoteAction {
  gaId: string;
  title: string;
  prevVote: string | null;
}

export interface MultiVoteBarProps {
  network: CardanoNetwork;
  actions: MultiVoteAction[];
}

type Phase =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'checking'; identity: DRepIdentity }
  | { status: 'form'; identity: DRepIdentity }
  | { status: 'submitting'; identity: DRepIdentity }
  | { status: 'success'; txHash: string; count: number }
  | { status: 'error'; message: string; identity?: DRepIdentity };

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

// Draft persistence: the batch (selections, rationale texts, cross-post flag)
// survives a reload, tab close, or browser crash until the transaction is
// submitted or the DRep clears it. Rationale texts are the valuable part; a
// long CIP-100 text must never die with the tab.
export const DRAFT_STORAGE_KEY = 'dreptalk:multivote-draft';

export interface MultiVoteDraft {
  selections: Record<string, VoteChoice>;
  sharedRationale: string;
  overrides: Record<string, string>;
  crossPost: boolean;
}

const VOTE_CHOICES: readonly VoteChoice[] = ['yes', 'no', 'abstain'];

/**
 * Parses a stored draft and prunes it to the currently open actions, so a
 * draft never resurrects a closed action. Returns null for corrupt or empty
 * drafts. Pure; exported for unit tests.
 */
export function restoreDraft(raw: string | null, validGaIds: string[]): MultiVoteDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MultiVoteDraft>;
    const valid = new Set(validGaIds);
    const selections: Record<string, VoteChoice> = {};
    for (const [gaId, choice] of Object.entries(parsed.selections ?? {})) {
      if (valid.has(gaId) && VOTE_CHOICES.includes(choice as VoteChoice)) {
        selections[gaId] = choice as VoteChoice;
      }
    }
    const overrides: Record<string, string> = {};
    for (const [gaId, text] of Object.entries(parsed.overrides ?? {})) {
      if (valid.has(gaId) && typeof text === 'string' && text.trim().length > 0) {
        overrides[gaId] = text;
      }
    }
    const sharedRationale = typeof parsed.sharedRationale === 'string' ? parsed.sharedRationale : '';
    const crossPost = parsed.crossPost === true;
    if (Object.keys(selections).length === 0 && Object.keys(overrides).length === 0 && sharedRationale.trim().length === 0) {
      return null;
    }
    return { selections, sharedRationale, overrides, crossPost };
  } catch {
    return null;
  }
}

/** Immutable selection toggle: same choice again deselects the action. */
export function toggleSelection(
  selections: Record<string, VoteChoice>,
  gaId: string,
  choice: VoteChoice,
): Record<string, VoteChoice> {
  const next = { ...selections };
  if (next[gaId] === choice) delete next[gaId];
  else next[gaId] = choice;
  return next;
}

/** Per-action override wins over the shared text; empty everywhere = none. */
export function effectiveRationale(shared: string, override: string): string {
  const o = override.trim();
  if (o.length > 0) return o;
  return shared.trim();
}

// The rationale hosting endpoint is rate limited to 10 requests per minute per
// IP, and each DISTINCT text in a batch costs one request (identical texts are
// hosted once). Capping distinct texts at that limit means a batch can never
// 429 mid-hosting; the UI blocks submission above it, and submitMultiVote
// enforces it defensively.
export const MAX_UNIQUE_BATCH_RATIONALES = 10;

/** Number of distinct non-empty effective rationale texts across a selection. */
export function countUniqueRationales(
  gaIds: string[],
  shared: string,
  overrides: Record<string, string>,
): number {
  const texts = new Set<string>();
  for (const gaId of gaIds) {
    const text = effectiveRationale(shared, overrides[gaId] ?? '');
    if (text.length > 0) texts.add(text);
  }
  return texts.size;
}

/**
 * A failure that happened strictly BEFORE the wallet could sign anything
 * (validation, rationale hosting, loading the tx-builder module). The error
 * handler shows these as-is and skips the "a batch vote is all-or-nothing"
 * note, which only makes sense once a transaction could actually have failed.
 */
export class PreSignError extends Error {}

export interface SubmitMultiVoteDeps {
  hostRationale: (args: { gaId: string; drepId: string; rationale: string }) => Promise<{ url: string; hash: string }>;
  castVotes: (opts: CastDRepVotesOpts) => Promise<{ txHash: string }>;
  recordVotes: (args: {
    txHash: string;
    votes: Array<{ gaId: string; vote: VoteChoice; rationaleUrl?: string; rationaleText?: string; crossPost?: boolean }>;
  }) => Promise<void>;
}

/**
 * Pure orchestration of the batch submit: resolve effective rationales, host
 * each unique text once (the store is content-addressed, so identical texts
 * share one anchor), cast all votes in one transaction, record the batch.
 * Exported so the node test can inject mocks for all three deps.
 */
export async function submitMultiVote(
  deps: SubmitMultiVoteDeps,
  args: {
    selections: Array<{ gaId: string; choice: VoteChoice }>;
    sharedRationale: string;
    overrides: Record<string, string>;
    crossPost: boolean;
    drepId: string;
    drepKeyHash: Uint8Array;
    network: CardanoNetwork;
    origin: string;
    walletApi: TxWalletApi;
  },
): Promise<{ txHash: string }> {
  if (args.selections.length === 0) {
    throw new Error('No votes selected.');
  }
  const perAction = args.selections.map((s) => ({
    ...s,
    text: effectiveRationale(args.sharedRationale, args.overrides[s.gaId] ?? ''),
  }));

  // Never start hosting a batch the rate limit cannot finish: one dead request
  // mid-loop would abort the whole submit (safely, before signing, but still
  // a frustrating dead end for the DRep).
  const uniqueTexts = new Set(perAction.map((p) => p.text).filter((t) => t.length > 0));
  if (uniqueTexts.size > MAX_UNIQUE_BATCH_RATIONALES) {
    throw new PreSignError(
      `This batch has ${uniqueTexts.size} different rationale texts; at most ${MAX_UNIQUE_BATCH_RATIONALES} are supported per submission. Reuse the shared rationale for some votes, or split the batch.`,
    );
  }

  // Host each unique rationale text once; identical texts share an anchor.
  const anchors = new Map<string, { url: string; hash: string }>();
  for (const p of perAction) {
    if (p.text.length > 0 && !anchors.has(p.text)) {
      anchors.set(p.text, await deps.hostRationale({ gaId: p.gaId, drepId: args.drepId, rationale: p.text }));
    }
  }

  const { txHash } = await deps.castVotes({
    walletApi: args.walletApi,
    network: args.network,
    drepKeyHash: args.drepKeyHash,
    origin: args.origin,
    votes: perAction.map((p) => {
      const anchor = p.text.length > 0 ? anchors.get(p.text) : undefined;
      return { govActionId: p.gaId, vote: p.choice, anchorUrl: anchor?.url, anchorHashHex: anchor?.hash };
    }),
  });

  // Recording is non-fatal BY CONTRACT: at this point the votes are already
  // on chain, so a failed optimistic record (HTTP error or thrown timeout)
  // must never surface as a submit error; the periodic sync heals it.
  try {
    await deps.recordVotes({
      txHash,
      votes: perAction.map((p) => {
        const anchor = p.text.length > 0 ? anchors.get(p.text) : undefined;
        return {
          gaId: p.gaId,
          vote: p.choice,
          rationaleUrl: anchor?.url,
          rationaleText: p.text.length > 0 ? p.text : undefined,
          crossPost: p.text.length > 0 ? args.crossPost : undefined,
        };
      }),
    });
  } catch (err) {
    console.warn('[MultiVoteBar] recording votes failed (votes are on chain)', err);
  }

  return { txHash };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Same tone variables the vote badges and row pills use (TONE_COLORS in
// governance/view.ts), so choice colors never drift between surfaces.
const CHOICE_COLORS: Record<VoteChoice, string> = {
  yes: 'var(--c-pos)',
  no: 'var(--c-neg)',
  abstain: 'var(--muted)',
};

export default function MultiVoteBar({ network, actions }: MultiVoteBarProps) {
  const { wallets, selected, setSelected } = useCardanoWallets();
  const [selections, setSelections] = useState<Record<string, VoteChoice>>({});
  const [expanded, setExpanded] = useState(false);
  const [sharedRationale, setSharedRationale] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // Which rationale the modal editor (with Markdown preview) is bound to:
  // 'shared' or a gaId ("<64hex>#<n>", so it can never collide with 'shared').
  const [rationaleModalTarget, setRationaleModalTarget] = useState<'shared' | string | null>(null);
  const [crossPost, setCrossPost] = useState(false);
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [droppedNotice, setDroppedNotice] = useState<string[]>([]);
  const enabledApiRef = useRef<EnabledWalletApi | null>(null);

  const byId = new Map(actions.map((a) => [a.gaId, a]));
  const items = Object.entries(selections)
    .filter(([gaId]) => byId.has(gaId))
    .map(([gaId, choice]) => ({ action: byId.get(gaId) as MultiVoteAction, choice }));

  const busy = phase.status === 'connecting' || phase.status === 'checking' || phase.status === 'submitting';

  // Distinct rationale texts are capped by the hosting rate limit; block the
  // submit (with a notice) instead of letting the batch die on a 429.
  const uniqueRationales = countUniqueRationales(
    items.map((i) => i.action.gaId),
    sharedRationale,
    overrides,
  );
  const tooManyRationales = uniqueRationales > MAX_UNIQUE_BATCH_RATIONALES;

  // Selections that would replace an earlier on-chain vote (same choice as
  // before does not count): surfaced as a subtle counter in the collapsed bar.
  const revoteCount = items.filter(
    (i) => i.action.prevVote && i.action.prevVote.toLowerCase() !== i.choice,
  ).length;

  // Mirrored into a ref because the delegated click handler below is
  // registered once with [] deps and cannot read `busy` from the closure.
  const busyRef = useRef(false);
  busyRef.current = busy;

  // Draft persistence. Restore runs once after hydration (localStorage does
  // not exist during SSR, and reading it in the initial state would make the
  // client render diverge from the server-rendered null). The persist effect
  // stays quiet until the restore attempt finished so it can never clobber a
  // stored draft with the pre-restore empty state.
  const draftRestoredRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: actions is SSR data, render-stable for the page's lifetime; the restore must run exactly once
  useEffect(() => {
    const draft = restoreDraft(
      window.localStorage.getItem(DRAFT_STORAGE_KEY),
      actions.map((a) => a.gaId),
    );
    if (draft) {
      setSelections(draft.selections);
      setSharedRationale(draft.sharedRationale);
      setOverrides(draft.overrides);
      setCrossPost(draft.crossPost);
    }
    draftRestoredRef.current = true;
    // actions is render-stable per page load (SSR data); run once on mount.
  }, []);
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    const empty =
      Object.keys(selections).length === 0 &&
      sharedRationale.trim().length === 0 &&
      Object.values(overrides).every((t) => t.trim().length === 0);
    try {
      if (empty) window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      else {
        const draft: MultiVoteDraft = { selections, sharedRationale, overrides, crossPost };
        window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      }
    } catch {
      // Storage can be full or blocked; drafting is best-effort, never fatal.
    }
  }, [selections, sharedRationale, overrides, crossPost]);

  // Event delegation: the row buttons are SSR markup owned by vote.astro.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const btn = (e.target as HTMLElement).closest?.('[data-mv-choice]') as HTMLElement | null;
      if (!btn) return;
      // Freeze the selection while a submit is in flight (connect through
      // record): letting it change here would desync the review panel from
      // the transaction the wallet is already signing, and a mid-flight
      // change would be silently wiped by resetBatchState() on success.
      if (busyRef.current) return;
      const gaId = btn.dataset.ga;
      const choice = btn.dataset.mvChoice as VoteChoice | undefined;
      if (!gaId || !choice) return;
      setSelections((prev) => toggleSelection(prev, gaId, choice));
      setDroppedNotice([]);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Mirror the selection back onto the SSR buttons.
  useEffect(() => {
    for (const btn of Array.from(document.querySelectorAll<HTMLElement>('[data-mv-choice]'))) {
      const active = selections[btn.dataset.ga ?? ''] === btn.dataset.mvChoice;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }, [selections]);

  // Mirror the busy state onto the SSR buttons: visual + AT feedback that
  // the pills are frozen while a submit is in flight.
  useEffect(() => {
    for (const btn of Array.from(document.querySelectorAll<HTMLElement>('[data-mv-choice]'))) {
      btn.classList.toggle('is-disabled', busy);
      if (busy) btn.setAttribute('aria-disabled', 'true');
      else btn.removeAttribute('aria-disabled');
    }
  }, [busy]);

  function removeItem(gaId: string) {
    setSelections((prev) => {
      const next = { ...prev };
      delete next[gaId];
      return next;
    });
  }

  // Full batch reset: used by Clear and by the success path so a rationale
  // written for one batch can never silently carry over into (and be
  // published on-chain for) an unrelated later batch.
  function resetBatchState() {
    setSelections({});
    setSharedRationale('');
    setOverrides({});
    setRationaleModalTarget(null);
    setCrossPost(false);
    setDroppedNotice([]);
    setExpanded(false);
    // The persist effect would remove the empty draft anyway; do it eagerly so
    // a crash right after success/clear cannot resurrect the submitted batch.
    try {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      // Best-effort, like all draft storage.
    }
  }

  async function handleConnect() {
    const walletInfo = wallets.find((w) => w.key === selected);
    if (!walletInfo) return;
    setPhase({ status: 'connecting' });
    try {
      const { api, identity } = await connectAsDrep(walletInfo.raw, network, {
        onEnabled: (enabledApi) => {
          enabledApiRef.current = enabledApi;
          rememberWallet(selected);
        },
        onChecking: (identity) => setPhase({ status: 'checking', identity }),
      });
      enabledApiRef.current = api;
      setPhase({ status: 'form', identity });
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
    }
  }

  async function handleSubmit(identity: DRepIdentity) {
    const api = enabledApiRef.current;
    if (!api) {
      setPhase({ status: 'error', message: 'Wallet connection was lost. Please reconnect.', identity });
      return;
    }
    const gaIds = items.map((i) => i.action.gaId);

    setPhase({ status: 'submitting', identity });

    // Liveness re-check: one stale action would invalidate the WHOLE batch
    // transaction, so drop stale actions BEFORE the wallet signs. A failed
    // read falls through; the chain remains the final gate.
    try {
      const res = await fetchWithTimeout('/api/vote/liveness', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gaIds }),
      });
      if (res.ok) {
        const { active } = (await res.json()) as { active: string[] };
        const activeSet = new Set(active);
        const dropped = gaIds.filter((id) => !activeSet.has(id));
        if (dropped.length > 0) {
          setSelections((prev) => {
            const next = { ...prev };
            for (const id of dropped) delete next[id];
            return next;
          });
          setDroppedNotice(dropped.map((id) => byId.get(id)?.title ?? id));
          // Explicit re-confirm required: back to the form, nothing signed.
          setPhase({ status: 'form', identity });
          return;
        }
      }
    } catch {
      // Fall through: liveness is best-effort, submit remains the final gate.
    }

    const realDeps: SubmitMultiVoteDeps = {
      async hostRationale({ gaId, drepId, rationale }) {
        const res = await fetchWithTimeout('/api/vote/rationale', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ drepId, gaId, rationale }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new PreSignError(
            body?.error ? `Could not host rationale: ${body.error}.` : 'Could not host a vote rationale. Please try again.',
          );
        }
        return res.json() as Promise<{ url: string; hash: string }>;
      },
      async castVotes(opts) {
        // Lazy-import so the heavy SDK only loads when the user submits. The
        // import itself can fail on a stale page (after a deploy the old hashed
        // chunk is gone); translate that into a reload hint instead of a
        // cryptic fetch error. Nothing was signed at this point.
        let mod: typeof import('@/lib/governance/drepTx.js');
        try {
          mod = await import('@/lib/governance/drepTx.js');
        } catch {
          throw new PreSignError(
            'Could not load the transaction builder; this page may be outdated after a site update. Please reload the page and try again. No vote was submitted.',
          );
        }
        return mod.castDRepVotes(opts);
      },
      async recordVotes(rec) {
        const res = await fetchWithTimeout('/api/vote/record', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(rec),
        });
        if (!res.ok) {
          // Non-fatal: the votes are already on chain; the hourly sync heals.
          console.warn('[MultiVoteBar] /api/vote/record failed', res.status);
        }
      },
    };

    try {
      const { txHash } = await submitMultiVote(realDeps, {
        selections: items.map((i) => ({ gaId: i.action.gaId, choice: i.choice })),
        sharedRationale,
        overrides,
        crossPost,
        drepId: identity.drepId,
        drepKeyHash: identity.drepKeyHash,
        network,
        origin: window.location.origin,
        walletApi: api,
      });
      const count = items.length;
      resetBatchState();
      setPhase({ status: 'success', txHash, count });
    } catch (err) {
      // Pre-sign failures carry their own complete message; the all-or-nothing
      // note only applies once a transaction could actually have been rejected.
      const msg =
        err instanceof PreSignError
          ? err.message
          : `${expiredActionMessage(err) ?? readableError(err)} Note: a batch vote is all-or-nothing; if one action closed, no vote in this batch was cast.`;
      setPhase({ status: 'error', message: msg, identity });
    }
  }

  // Nothing selected, no result, and no dropped-actions notice: render
  // nothing. The notice must keep the bar alive even with zero items, or a
  // liveness check that drops EVERY selected action would hide the bar before
  // the user ever learns why the batch vanished.
  if (items.length === 0 && phase.status !== 'success' && droppedNotice.length === 0) return null;

  const barStyle: React.CSSProperties = {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    background: 'var(--bg)',
    borderTop: '1px solid var(--border)',
    boxShadow: '0 -4px 16px rgba(0,0,0,0.08)',
  };
  const innerStyle: React.CSSProperties = {
    maxWidth: '48rem',
    margin: '0 auto',
    padding: '0.75rem 1rem',
  };

  // Every selected action was dropped by the liveness re-check: keep the bar
  // up with only the explanation. Nothing can be signed in this state (there
  // are no items); Close dismisses the notice and hides the bar.
  if (items.length === 0 && phase.status !== 'success') {
    return (
      <div style={barStyle}>
        <div style={innerStyle}>
          <div className="callout callout--info" role="status">
            <div className="callout__body">
              Removed from your batch because voting has closed: {droppedNotice.join(', ')}. No vote was cast.
            </div>
          </div>
          <button type="button" className="btn btn--sm" style={{ marginTop: '0.5rem' }} onClick={() => setDroppedNotice([])}>
            Close
          </button>
        </div>
      </div>
    );
  }

  // Success state replaces the bar content until dismissed.
  if (phase.status === 'success') {
    return (
      <div style={barStyle} role="status">
        <div style={innerStyle}>
          <p style={{ margin: '0 0 0.25rem', fontWeight: 600 }}>
            {phase.count === 1 ? 'Vote submitted' : `${phase.count} votes submitted in one transaction`}
          </p>
          <p style={{ margin: '0 0 0.5rem', overflowWrap: 'anywhere', fontSize: '0.875rem' }}>
            Transaction:{' '}
            <a href={txExplorerUrl(network, phase.txHash)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>
              {phase.txHash}
            </a>
            <CopyButton value={phase.txHash} label="Copy transaction hash" />
          </p>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.8125rem' }}>
            Your votes will appear on-chain once the transaction is confirmed. Refresh the page to update the list.
          </p>
          <button type="button" className="btn btn--sm" style={{ marginTop: '0.5rem' }} onClick={() => setPhase({ status: 'idle' })}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={barStyle}>
      <div style={innerStyle}>
        {/* Collapsed bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>
            {items.length} {items.length === 1 ? 'vote' : 'votes'} selected
          </span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn--sm" onClick={resetBatchState} disabled={busy}>
              Clear
            </button>
            <button type="button" className="btn btn-primary btn--sm" onClick={() => setExpanded((e) => !e)} disabled={busy && !expanded}>
              {expanded ? 'Hide review' : 'Review & submit'}
            </button>
          </div>
        </div>

        {/* Re-vote admonition: clearly visible without expanding the review,
            but not a blocker; overriding an earlier vote is legitimate (the
            newest on-chain vote counts). Per-action details sit in the review. */}
        {revoteCount > 0 && (
          <div className="callout callout--warning" role="status" style={{ marginTop: '0.625rem' }}>
            <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <div className="callout__body">
              {revoteCount === 1
                ? 'One of these votes changes an earlier on-chain vote.'
                : `${revoteCount} of these votes change earlier on-chain votes.`}{' '}
              The review shows which.
            </div>
          </div>
        )}

        {/* Review panel */}
        {expanded && (
          <div style={{ marginTop: '0.75rem', maxHeight: '60vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {droppedNotice.length > 0 && (
              <div className="callout callout--info" role="status">
                <div className="callout__body">
                  Removed from your batch because voting has closed: {droppedNotice.join(', ')}. Review the remaining votes and submit again.
                </div>
              </div>
            )}

            {/* Selected actions */}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {items.map(({ action, choice }) => (
                <li key={action.gaId} style={{ border: '1px solid var(--border)', borderRadius: '0.375rem', padding: '0.5rem 0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <span style={{ fontSize: '0.875rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {action.title}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                      <span style={{ fontSize: '0.8125rem', fontWeight: 700, textTransform: 'uppercase', color: CHOICE_COLORS[choice] }}>
                        {choice}
                      </span>
                      <button type="button" onClick={() => removeItem(action.gaId)} disabled={busy} aria-label={`Remove ${action.title} from batch`}
                        style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: busy ? 'not-allowed' : 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline', fontSize: '0.8125rem' }}>
                        Remove
                      </button>
                    </span>
                  </div>
                  {action.prevVote && action.prevVote.toLowerCase() !== choice && (
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--accent)' }}>
                      Changes your previous {action.prevVote.toLowerCase()} vote.
                    </p>
                  )}
                  <div style={{ marginTop: '0.375rem', fontSize: '0.8125rem' }}>
                    {(overrides[action.gaId] ?? '').trim() ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <span>Custom rationale, {(overrides[action.gaId] ?? '').length} characters.</span>
                        <button type="button" onClick={() => setRationaleModalTarget(action.gaId)} disabled={busy}
                          style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: busy ? 'not-allowed' : 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}>
                          Edit
                        </button>
                        <button type="button" onClick={() => setOverrides((p) => ({ ...p, [action.gaId]: '' }))} disabled={busy}
                          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: busy ? 'not-allowed' : 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}>
                          Remove
                        </button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setRationaleModalTarget(action.gaId)} disabled={busy}
                        style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: busy ? 'not-allowed' : 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}>
                        Add a custom rationale for this action
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {/* Shared rationale: edited in the roomy modal (Markdown + preview),
                mirroring the single-vote flow. */}
            <div>
              <span style={{ display: 'block', fontSize: '0.875rem', color: 'var(--muted)', fontWeight: 500, marginBottom: '0.375rem' }}>
                Shared rationale <span style={{ fontWeight: 400 }}>(optional, published on-chain as CIP-100, applied to every vote without a custom rationale)</span>
              </span>
              {sharedRationale.trim() ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.875rem' }}>
                  <span>Rationale added, {sharedRationale.length} characters.</span>
                  <button type="button" onClick={() => setRationaleModalTarget('shared')} disabled={busy}
                    style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: busy ? 'not-allowed' : 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}>
                    Edit
                  </button>
                  <button type="button" onClick={() => setSharedRationale('')} disabled={busy}
                    style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: busy ? 'not-allowed' : 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}>
                    Remove
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setRationaleModalTarget('shared')}
                  disabled={busy}
                  style={{ padding: '0.5rem 0.875rem', border: '1px solid var(--border)', borderRadius: '0.375rem', background: 'var(--bg)', color: 'var(--fg)', cursor: busy ? 'not-allowed' : 'pointer', fontSize: '0.875rem' }}
                >
                  Write a shared rationale
                </button>
              )}
            </div>

            {(sharedRationale.trim() || Object.values(overrides).some((t) => t.trim())) && (
              <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.875rem' }}>
                <input type="checkbox" checked={crossPost} onChange={(e) => setCrossPost(e.target.checked)} disabled={busy} style={{ marginTop: '0.15rem' }} />
                <span>
                  Also post the rationales under Discussion.
                  <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.8125rem', marginTop: '0.15rem' }}>
                    Rationales are always recorded on-chain and shown under Positions. This only adds a copy to each discussion thread.
                  </span>
                </span>
              </label>
            )}

            {/* Wallet connect / submit */}
            {wallets.length === 0 ? (
              <p style={{ color: 'var(--muted)', margin: 0, fontSize: '0.875rem' }}>
                No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
              </p>
            ) : phase.status === 'idle' || phase.status === 'connecting' || phase.status === 'checking' || (phase.status === 'error' && !phase.identity) ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <WalletConnection wallets={wallets} selected={selected} onSelect={setSelected} disabled={busy} label="Signing wallet" />
                {phase.status === 'error' && !phase.identity && (
                  <div className="callout callout--error" role="alert">
                    <div className="callout__body">{phase.message}</div>
                  </div>
                )}
                <button type="button" className="btn btn-primary" onClick={() => void handleConnect()} disabled={busy} style={{ alignSelf: 'flex-start' }}>
                  {phase.status === 'connecting' || phase.status === 'checking' ? 'Connecting...' : phase.status === 'error' ? 'Try again' : 'Connect wallet'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {phase.status === 'error' && phase.identity && (
                  <div className="callout callout--error" role="alert">
                    <div className="callout__body">{phase.message}</div>
                  </div>
                )}
                {tooManyRationales && (
                  <div className="callout callout--info" role="status">
                    <div className="callout__body">
                      This batch has {uniqueRationales} different rationale texts; at most {MAX_UNIQUE_BATCH_RATIONALES} are supported per submission. Reuse the shared rationale for some votes, or split the batch.
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || items.length === 0 || tooManyRationales}
                  onClick={() => {
                    const identity =
                      phase.status === 'form' || phase.status === 'submitting'
                        ? phase.identity
                        : phase.status === 'error' && phase.identity
                          ? phase.identity
                          : null;
                    if (identity) void handleSubmit(identity);
                  }}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {phase.status === 'submitting'
                    ? 'Awaiting wallet...'
                    : `Submit ${items.length} ${items.length === 1 ? 'vote' : 'votes'} in one transaction`}
                </button>
                {phase.status === 'submitting' && (
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                    Please review and approve the transaction in your wallet. All selected votes are in this one transaction.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rationale editor with Markdown preview, bound to the shared text or to
          one action's custom override. Same modal the single-vote flow uses. */}
      {rationaleModalTarget !== null && (
        <RationaleModal
          value={rationaleModalTarget === 'shared' ? sharedRationale : (overrides[rationaleModalTarget] ?? '')}
          onChange={(v) =>
            rationaleModalTarget === 'shared'
              ? setSharedRationale(v)
              : setOverrides((p) => ({ ...p, [rationaleModalTarget]: v }))
          }
          onClose={() => setRationaleModalTarget(null)}
          title={rationaleModalTarget === 'shared' ? 'Write your shared rationale' : 'Write a custom rationale'}
          note={
            rationaleModalTarget === 'shared'
              ? 'Optional. Published on-chain (CIP-100) with every selected vote that has no custom rationale. Markdown is supported.'
              : 'Optional. Published on-chain (CIP-100) with this vote only, replacing the shared rationale for this action. Markdown is supported.'
          }
        />
      )}
    </div>
  );
}
