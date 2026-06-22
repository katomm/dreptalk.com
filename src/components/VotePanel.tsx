// React island: client-side, non-custodial DRep vote-casting flow.
//
// Non-custodial: the wallet signs and submits via castDRepVote. The server
// never sees a private key. On submit the flow: (1) optionally hosts the
// rationale via POST /api/vote/rationale to get a content-addressed anchor,
// (2) calls castDRepVote to build/sign/submit the vote tx, (3) records the
// optimistic result via POST /api/vote/record, (4) shows success with an
// explorer link. Connect/identity derivation mirrors DRepService exactly.
import { useState, useRef } from 'react';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import type { WalletApi as TxWalletApi } from '@/lib/governance/drepTx.js';
import type { CastDRepVoteOpts } from '@/lib/governance/drepTx.js';
import { drepIdFromKeyHash } from '@/lib/cardano/identity.js';
import { blake2b224 } from '@/lib/crypto/blake.js';
import { hexToBytes } from '@/lib/crypto/hex.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import { MAX_VOTE_RATIONALE } from '@/lib/governance/voteRationale.js';
import WalletConnection from '@/components/WalletConnection.js';
import type { ViewerVoteRow } from '@/lib/db/drepVotes.js';

// The enabled wallet api surface: CIP-30 tx methods + CIP-95 extension +
// getNetworkId for the network guard. Same shape as in DRepService.
type EnabledWalletApi = TxWalletApi & {
  getNetworkId(): Promise<number>;
  cip95?: { getPubDRepKey(): Promise<string> };
};

interface DRepIdentity {
  drepId: string;
  drepKeyHash: Uint8Array;
}

type VoteChoice = 'yes' | 'no' | 'abstain';

type Phase =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'form'; identity: DRepIdentity }
  | { status: 'submitting'; identity: DRepIdentity }
  | { status: 'success'; txHash: string }
  | { status: 'error'; message: string; identity?: DRepIdentity };

export interface VotePanelProps {
  gaId: string;
  network: CardanoNetwork;
  initialViewerVote: ViewerVoteRow | null;
}

// ---------------------------------------------------------------------------
// Dependency-injected orchestration (exported for unit testing)
// ---------------------------------------------------------------------------

export interface SubmitVoteDeps {
  hostRationale: (args: { gaId: string; drepId: string; rationale: string; origin: string }) => Promise<{ url: string; hash: string }>;
  castVote: (opts: CastDRepVoteOpts) => Promise<{ txHash: string }>;
  recordVote: (args: { gaId: string; vote: VoteChoice; txHash: string; rationaleUrl?: string; rationaleText?: string }) => Promise<void>;
}

/**
 * Pure orchestration: host rationale (when present), cast the vote tx, record
 * the result. Exported so the node test can inject mocks for all three deps.
 */
export async function submitVote(
  deps: SubmitVoteDeps,
  args: {
    gaId: string;
    vote: VoteChoice;
    rationaleText: string;
    drepId?: string;
    drepKeyHash: Uint8Array;
    network: CardanoNetwork;
    origin: string;
    walletApi?: TxWalletApi;
  },
): Promise<{ txHash: string }> {
  const hasRationale = args.rationaleText.trim().length > 0;
  let anchor: { url: string; hash: string } | undefined;
  if (hasRationale) {
    anchor = await deps.hostRationale({
      gaId: args.gaId,
      drepId: args.drepId ?? '',
      rationale: args.rationaleText,
      origin: args.origin,
    });
  }
  const { txHash } = await deps.castVote({
    walletApi: args.walletApi as TxWalletApi,
    network: args.network,
    drepKeyHash: args.drepKeyHash,
    govActionId: args.gaId,
    vote: args.vote,
    anchorUrl: anchor?.url,
    anchorHashHex: anchor?.hash,
    origin: args.origin,
  });
  await deps.recordVote({
    gaId: args.gaId,
    vote: args.vote,
    txHash,
    rationaleUrl: anchor?.url,
    rationaleText: hasRationale ? args.rationaleText : undefined,
  });
  return { txHash };
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export default function VotePanel({ gaId, network, initialViewerVote }: VotePanelProps) {
  const { wallets, selected, setSelected } = useCardanoWallets();
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });

  // Cached CIP-30 api: avoids a second enable() IPC round trip on submit,
  // mirroring DRepService's enabledApiRef pattern.
  const enabledApiRef = useRef<EnabledWalletApi | null>(null);

  // Vote form state.
  const [vote, setVote] = useState<VoteChoice>('yes');
  const [rationaleText, setRationaleText] = useState('');

  // When a prior vote exists, start in "change vote" mode if the user explicitly
  // requests it. The connect step is shown regardless (wallet auth is required).
  const [changingVote, setChangingVote] = useState(!initialViewerVote);

  const busy = phase.status === 'connecting' || phase.status === 'submitting';

  // ------------------------------------------------------------------
  // Step 1: connect wallet, run network guard, derive DRep identity.
  // Exact same code path as DRepService.handleConnect.
  // ------------------------------------------------------------------
  async function handleConnect() {
    const walletInfo = wallets.find((w) => w.key === selected);
    if (!walletInfo) return;

    setPhase({ status: 'connecting' });

    let api: EnabledWalletApi;
    try {
      api = (await walletInfo.raw.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi;
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return;
    }

    // Network guard: fail clearly before any tx is built.
    try {
      await assertWalletNetwork(api, network);
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return;
    }

    // CIP-95 must be present to read the DRep key.
    if (!api.cip95 || typeof api.cip95.getPubDRepKey !== 'function') {
      setPhase({
        status: 'error',
        message:
          'This wallet does not support CIP-95, which is required to vote as a DRep. Please use a DRep-capable wallet (e.g. Lace, Eternl, Typhon).',
      });
      return;
    }

    enabledApiRef.current = api;
    rememberWallet(selected);

    // Derive DRep key hash + bech32 id. Same derivation as DRepService.
    let identity: DRepIdentity;
    try {
      const pubKeyHex = await api.cip95.getPubDRepKey();
      const pubKeyBytes = hexToBytes(pubKeyHex);
      const drepKeyHash = blake2b224(pubKeyBytes);
      identity = { drepKeyHash, drepId: drepIdFromKeyHash(drepKeyHash) };
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return;
    }

    setPhase({ status: 'form', identity });
  }

  // ------------------------------------------------------------------
  // Step 2: submit the vote via the real deps.
  // ------------------------------------------------------------------
  async function handleSubmit(identity: DRepIdentity) {
    const api = enabledApiRef.current;
    if (!api) {
      setPhase({ status: 'error', message: 'Wallet connection was lost. Please reconnect.', identity });
      return;
    }

    setPhase({ status: 'submitting', identity });

    const realDeps: SubmitVoteDeps = {
      async hostRationale({ gaId: gId, drepId, rationale, origin: _origin }) {
        const res = await fetch('/api/vote/rationale', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ drepId, gaId: gId, rationale }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ? `Could not host rationale: ${body.error}.` : 'Could not host the vote rationale. Please try again.');
        }
        return res.json() as Promise<{ url: string; hash: string }>;
      },
      async castVote(opts) {
        // Lazy-import so the heavy SDK only loads when the user submits.
        const { castDRepVote } = await import('@/lib/governance/drepTx.js');
        return castDRepVote(opts);
      },
      async recordVote(rec) {
        const res = await fetch('/api/vote/record', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(rec),
        });
        if (!res.ok) {
          // Non-fatal: the vote is already on chain; a record failure is not
          // worth surfacing as an error. Log and continue.
          console.warn('[VotePanel] /api/vote/record failed', res.status);
        }
      },
    };

    try {
      const { txHash } = await submitVote(realDeps, {
        gaId,
        vote,
        rationaleText,
        drepId: identity.drepId,
        drepKeyHash: identity.drepKeyHash,
        network,
        origin: window.location.origin,
        walletApi: api,
      });
      setPhase({ status: 'success', txHash });
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err), identity });
    }
  }

  function reset() {
    enabledApiRef.current = null;
    setPhase({ status: 'idle' });
  }

  // ------------------------------------------------------------------
  // Render: success
  // ------------------------------------------------------------------
  if (phase.status === 'success') {
    return (
      <div style={{ maxWidth: '32rem' }}>
        <div className="callout callout--success" role="status">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Vote submitted</p>
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
            </p>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
              Your vote will appear on-chain once the transaction is confirmed.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Pre-connect: show prior vote state when present.
  // ------------------------------------------------------------------
  const priorVote = initialViewerVote;
  const showPriorVote = priorVote && !changingVote;

  return (
    <div style={{ maxWidth: '32rem' }}>
      {/* Prior vote summary (before user requests a change). */}
      {showPriorVote && priorVote && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', marginBottom: '1rem' }}>
          {priorVote.local_status === 'pending' ? (
            <div className="callout callout--info" role="status">
              <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <div className="callout__body">
                <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>
                  Vote submitted, awaiting on-chain confirmation
                </p>
                {priorVote.tx_hash && (
                  <p style={{ margin: '0 0 0.5rem', overflowWrap: 'anywhere' }}>
                    <a
                      href={txExplorerUrl(network, priorVote.tx_hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--accent)' }}
                    >
                      View transaction
                    </a>
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setChangingVote(true)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline', fontSize: '0.875rem' }}
                >
                  Change vote
                </button>
              </div>
            </div>
          ) : priorVote.local_status === 'failed' ? (
            <div className="callout callout--error" role="status">
              <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div className="callout__body">
                <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Previous vote transaction failed</p>
                <button
                  type="button"
                  onClick={() => setChangingVote(true)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline', fontSize: '0.875rem' }}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <div className="callout callout--success" role="status">
              <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <div className="callout__body">
                <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>
                  You voted {priorVote.vote.toLowerCase()}
                </p>
                <button
                  type="button"
                  onClick={() => setChangingVote(true)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline', fontSize: '0.875rem' }}
                >
                  Change vote
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Connect + vote form (shown immediately, or after "Change vote"). */}
      {changingVote && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          {wallets.length === 0 ? (
            <p style={{ color: 'var(--muted)', margin: 0 }}>
              No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
            </p>
          ) : (
            <>
              {/* Wallet picker: shown until the form phase is reached, or on a
                  connect-step error (no identity yet). */}
              {(phase.status === 'idle' ||
                phase.status === 'connecting' ||
                (phase.status === 'error' && !phase.identity)) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                  <WalletConnection
                    wallets={wallets}
                    selected={selected}
                    onSelect={setSelected}
                    disabled={busy}
                    label="Signing wallet"
                  />
                  <button
                    type="button"
                    onClick={() => void handleConnect()}
                    disabled={busy}
                    style={{
                      padding: '0.625rem 1.25rem',
                      background: 'var(--accent)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '0.375rem',
                      fontSize: '1rem',
                      fontWeight: 500,
                      cursor: busy ? 'not-allowed' : 'pointer',
                      opacity: busy ? 0.7 : 1,
                      alignSelf: 'flex-start',
                    }}
                  >
                    {phase.status === 'connecting'
                      ? 'Connecting...'
                      : phase.status === 'error'
                        ? 'Try again'
                        : 'Connect wallet'}
                  </button>
                </div>
              )}

              {/* Connect-step error (no identity): state the problem. */}
              {phase.status === 'error' && !phase.identity && (
                <div className="callout callout--error" role="alert">
                  <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <div className="callout__body">{phase.message}</div>
                </div>
              )}

              {/* Vote form: shown once connected. Stays mounted during submit
                  and on a submit-time error so the inputs are never lost. */}
              {(phase.status === 'form' ||
                phase.status === 'submitting' ||
                (phase.status === 'error' && phase.identity)) && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const identity =
                      phase.status === 'form' || phase.status === 'submitting'
                        ? phase.identity
                        : phase.status === 'error' && phase.identity
                          ? phase.identity
                          : null;
                    if (identity) void handleSubmit(identity);
                  }}
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}
                >
                  {/* Vote choice */}
                  <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
                    <legend style={{ fontSize: '0.875rem', color: 'var(--muted)', marginBottom: '0.5rem', fontWeight: 500 }}>
                      Your vote
                    </legend>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      {(['yes', 'no', 'abstain'] as const).map((v) => (
                        <label
                          key={v}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.375rem',
                            padding: '0.5rem 1rem',
                            border: `1px solid ${vote === v ? 'var(--accent)' : 'var(--border)'}`,
                            borderRadius: '0.375rem',
                            cursor: busy ? 'not-allowed' : 'pointer',
                            fontWeight: vote === v ? 600 : 400,
                            color: vote === v ? 'var(--accent)' : 'inherit',
                            background: vote === v ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
                            opacity: busy ? 0.7 : 1,
                            textTransform: 'capitalize',
                          }}
                        >
                          <input
                            type="radio"
                            name="vote"
                            value={v}
                            checked={vote === v}
                            onChange={() => setVote(v)}
                            disabled={busy}
                            style={{ display: 'none' }}
                          />
                          {v}
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  {/* Rationale (optional markdown) */}
                  <div>
                    <label
                      htmlFor="vote-rationale"
                      style={{ display: 'block', fontSize: '0.875rem', color: 'var(--muted)', fontWeight: 500, marginBottom: '0.375rem' }}
                    >
                      Rationale{' '}
                      <span style={{ fontWeight: 400 }}>(optional, published on-chain as CIP-100)</span>
                    </label>
                    <p style={{ margin: '0 0 0.375rem', fontSize: '0.8125rem', color: 'var(--muted)' }}>
                      Adding a rationale helps delegators understand your reasoning and builds trust.
                    </p>
                    <textarea
                      id="vote-rationale"
                      value={rationaleText}
                      onChange={(e) => setRationaleText(e.target.value)}
                      disabled={busy}
                      rows={5}
                      maxLength={MAX_VOTE_RATIONALE}
                      style={{
                        width: '100%',
                        resize: 'vertical',
                        fontFamily: 'inherit',
                        fontSize: '0.9375rem',
                        padding: '0.5rem 0.75rem',
                        border: '1px solid var(--border)',
                        borderRadius: '0.375rem',
                        background: 'var(--surface)',
                        color: 'inherit',
                        boxSizing: 'border-box',
                        opacity: busy ? 0.7 : 1,
                      }}
                      placeholder="Explain your vote (Markdown supported)..."
                    />
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: rationaleText.length > MAX_VOTE_RATIONALE * 0.9 ? 'var(--accent)' : 'var(--muted)', textAlign: 'right' }}>
                      {rationaleText.length} / {MAX_VOTE_RATIONALE}
                    </p>
                  </div>

                  {/* Submit-time error: keep the form so the user can retry. */}
                  {phase.status === 'error' && phase.identity && (
                    <div className="callout callout--error" role="alert">
                      <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <div className="callout__body">
                        {phase.message}{' '}
                        <button
                          type="button"
                          onClick={reset}
                          style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}
                        >
                          Use a different wallet
                        </button>
                      </div>
                    </div>
                  )}

                  <div>
                    <button
                      type="submit"
                      disabled={busy}
                      style={{
                        padding: '0.625rem 1.25rem',
                        background: busy ? 'var(--muted)' : 'var(--accent)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '0.375rem',
                        fontSize: '1rem',
                        fontWeight: 500,
                        cursor: busy ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {phase.status === 'submitting' ? 'Awaiting wallet...' : 'Cast vote'}
                    </button>
                  </div>

                  {phase.status === 'submitting' && (
                    <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                      Please review and approve the transaction in your wallet.
                    </p>
                  )}
                </form>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
