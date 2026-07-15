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
import { CopyButton } from '@/components/CopyButton.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { MAX_VOTE_RATIONALE } from '@/lib/governance/voteRationale.js';

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

const CHOICE_COLORS: Record<VoteChoice, string> = {
  yes: 'var(--success, #22a06b)',
  no: 'var(--danger, #d64545)',
  abstain: 'var(--muted)',
};

export default function MultiVoteBar({ network, actions }: MultiVoteBarProps) {
  const { wallets, selected, setSelected } = useCardanoWallets();
  const [selections, setSelections] = useState<Record<string, VoteChoice>>({});
  const [expanded, setExpanded] = useState(false);
  const [sharedRationale, setSharedRationale] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({});
  const [crossPost, setCrossPost] = useState(false);
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [droppedNotice, setDroppedNotice] = useState<string[]>([]);
  const enabledApiRef = useRef<EnabledWalletApi | null>(null);

  const byId = new Map(actions.map((a) => [a.gaId, a]));
  const items = Object.entries(selections)
    .filter(([gaId]) => byId.has(gaId))
    .map(([gaId, choice]) => ({ action: byId.get(gaId) as MultiVoteAction, choice }));

  const busy = phase.status === 'connecting' || phase.status === 'checking' || phase.status === 'submitting';

  // Event delegation: the row buttons are SSR markup owned by vote.astro.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const btn = (e.target as HTMLElement).closest?.('[data-mv-choice]') as HTMLElement | null;
      if (!btn) return;
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
    setOpenOverrides({});
    setCrossPost(false);
    setDroppedNotice([]);
    setExpanded(false);
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
          throw new Error(
            body?.error ? `Could not host rationale: ${body.error}.` : 'Could not host a vote rationale. Please try again.',
          );
        }
        return res.json() as Promise<{ url: string; hash: string }>;
      },
      async castVotes(opts) {
        // Lazy-import so the heavy SDK only loads when the user submits.
        const { castDRepVotes } = await import('@/lib/governance/drepTx.js');
        return castDRepVotes(opts);
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
      const msg = expiredActionMessage(err) ?? readableError(err);
      setPhase({
        status: 'error',
        message: `${msg} Note: a batch vote is all-or-nothing; if one action closed, no vote in this batch was cast.`,
        identity,
      });
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
      <div style={barStyle} role="status">
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
                  <div style={{ marginTop: '0.375rem' }}>
                    <button type="button" onClick={() => setOpenOverrides((p) => ({ ...p, [action.gaId]: !p[action.gaId] }))} disabled={busy}
                      style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: busy ? 'not-allowed' : 'pointer', padding: 0, font: 'inherit', fontSize: '0.8125rem', textDecoration: 'underline' }}>
                      {openOverrides[action.gaId] || (overrides[action.gaId] ?? '').trim() ? 'Custom rationale for this action' : 'Add a custom rationale for this action'}
                    </button>
                    {(openOverrides[action.gaId] || (overrides[action.gaId] ?? '').trim()) && (
                      <textarea
                        value={overrides[action.gaId] ?? ''}
                        onChange={(e) => setOverrides((p) => ({ ...p, [action.gaId]: e.target.value }))}
                        disabled={busy}
                        maxLength={MAX_VOTE_RATIONALE}
                        rows={3}
                        placeholder="Overrides the shared rationale for this action only"
                        style={{ width: '100%', marginTop: '0.375rem', fontFamily: 'inherit', fontSize: '0.875rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', resize: 'vertical' }}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {/* Shared rationale */}
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', color: 'var(--muted)', fontWeight: 500, marginBottom: '0.375rem' }}>
                Shared rationale <span style={{ fontWeight: 400 }}>(optional, published on-chain as CIP-100, applied to every vote without a custom rationale)</span>
                <textarea
                  value={sharedRationale}
                  onChange={(e) => setSharedRationale(e.target.value)}
                  disabled={busy}
                  maxLength={MAX_VOTE_RATIONALE}
                  rows={4}
                  style={{ width: '100%', marginTop: '0.375rem', fontFamily: 'inherit', fontSize: '0.875rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', resize: 'vertical' }}
                />
              </label>
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
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || items.length === 0}
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
    </div>
  );
}
