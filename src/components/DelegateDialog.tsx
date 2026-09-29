// Shared non-custodial vote-delegation dialog. Opened from the /dreps table row
// menu (DrepActionsMenu) and from the "Delegate voting power" CTA on a DRep
// profile (DelegateButton). The server never sees a key: the wallet signs and
// submits the vote_deleg certificate. The Evolution SDK tx builder is pulled in
// lazily (dynamic import at submit time) so callers do not ship the heavy tx
// bundle on first load.
import { useRef, useState } from 'react';
import { CopyButton } from '@/components/CopyButton.js';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import { useDialogA11y } from '@/components/useDialogA11y.js';
import WalletConnection from '@/components/WalletConnection.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import type { WalletApi } from '@/lib/governance/drepTx.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import { truncateIdMiddle } from '@/lib/forum/view.js';
import { loginWithWallet } from '@/lib/auth/walletLogin.js';
import { trackingOffer, type TrackState, type TrackingViewer } from '@/lib/delegation/trackingOffer.js';
import { refFromUrl } from '@/lib/analytics/signupRef.js';

// The enabled CIP-30 surface we use here: the tx WalletApi plus getNetworkId,
// which the network guard reads (enable() returns the full object at runtime).
export type EnabledWalletApi = WalletApi & { getNetworkId(): Promise<number> };

// Identity of the DRep being delegated to. credentialHex is the 28-byte
// credential the dreps table stores (Koios `hex`); null means we could not
// resolve it, so delegation is offered as disabled by the caller.
export interface Target {
  drepId: string;
  /** SEO profile slug when assigned; the profile link prefers it over the id. */
  slug: string | null;
  name: string;
  credentialHex: string | null;
  isScript: boolean;
}

type DelegatePhase =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'confirm'; rewardAddressHex: string }
  | { status: 'submitting'; rewardAddressHex: string }
  | { status: 'success'; txHash: string }
  | { status: 'error'; message: string };

/** Where this dialog was opened from, used as the origin token when the page
 *  URL carries no ref of its own. */
export type DelegateSource = 'delegate-dialog' | 'match';

export default function DelegateDialog({
  target,
  network,
  viewer,
  source = 'delegate-dialog',
  onClose,
}: {
  target: Target;
  network: CardanoNetwork;
  viewer: TrackingViewer;
  source?: DelegateSource;
  onClose: () => void;
}) {
  const { wallets, selected, setSelected } = useCardanoWallets();
  const [phase, setPhase] = useState<DelegatePhase>({ status: 'idle' });
  const [trackState, setTrackState] = useState<TrackState>('idle');
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signedInNow, setSignedInNow] = useState(false);
  const apiRef = useRef<EnabledWalletApi | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const busy = phase.status === 'connecting' || phase.status === 'submitting';

  // Escape / outside-click close (never mid-flight, so a wallet round-trip is not
  // orphaned), plus focus trap and focus restore on close. dismissable tracks the
  // live busy state.
  useDialogA11y({ panelRef, onClose, dismissable: !busy });

  const shortId = truncateIdMiddle(target.drepId, 12, 6);

  async function handleConnect() {
    const walletInfo = wallets.find((w) => w.key === selected);
    if (!walletInfo) return;
    setPhase({ status: 'connecting' });

    let api: EnabledWalletApi;
    try {
      // Normal CIP-30 enable; delegation needs no CIP-95 extension. The hook
      // types enable() as the narrow login api; at runtime it is the full CIP-30
      // surface, so we view it through the richer tx WalletApi via unknown.
      api = (await walletInfo.raw.enable()) as unknown as EnabledWalletApi;
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return;
    }
    apiRef.current = api;
    // Remember the wallet as soon as it is enabled, like every other signing
    // flow, so the next one starts on the wallet the user actually delegates with.
    rememberWallet(selected);

    // Catch a network mismatch (e.g. wallet on Mainnet, app on Preprod) here, so
    // the user gets a clear "switch your wallet" message rather than the cryptic
    // SDK error at build time.
    try {
      await assertWalletNetwork(api, network);
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return;
    }

    let rewardAddressHex: string | undefined;
    try {
      rewardAddressHex = (await api.getRewardAddresses())[0];
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return;
    }
    if (!rewardAddressHex) {
      setPhase({
        status: 'error',
        message: 'No stake address found in this wallet. A registered stake key is required to delegate.',
      });
      return;
    }

    // Voting-power delegation requires the wallet's stake key to be registered
    // on-chain. An unregistered stake key makes the node reject the vote_deleg
    // certificate, which wallets surface only as a generic "failed to submit"
    // error. Check first so we can explain the real reason. A failed check
    // (Koios hiccup) must not block a valid delegation, so we proceed on error.
    try {
      const { fetchStakeRegistration } = await import('@/lib/governance/stakeAccount.js');
      const reg = await fetchStakeRegistration({ rewardAddressHex, network, origin: window.location.origin });
      if (!reg.registered) {
        setPhase({
          status: 'error',
          message:
            'This wallet has no registered stake key yet, so it cannot delegate voting power. Register your stake key first (for example by delegating your ada to a stake pool in your wallet), then come back to delegate to a DRep.',
        });
        return;
      }
    } catch {
      // Registration status could not be read; fall through and let the user try.
    }

    setPhase({ status: 'confirm', rewardAddressHex });
  }

  async function handleDelegate(rewardAddressHex: string) {
    const api = apiRef.current;
    if (!api) {
      setPhase({ status: 'error', message: 'Wallet connection was lost. Please reconnect.' });
      return;
    }
    if (!target.credentialHex) {
      setPhase({ status: 'error', message: 'This DRep credential could not be resolved.' });
      return;
    }
    setPhase({ status: 'submitting', rewardAddressHex });
    try {
      // Lazy-load the tx builder (and with it the Evolution SDK) only now, so the
      // caller never ships the heavy bundle just to render a button.
      const { delegateVotesToDRep } = await import('@/lib/governance/drepTx.js');
      const { txHash } = await delegateVotesToDRep({
        walletApi: api,
        network,
        rewardAddressHex,
        drepCredentialHex: target.credentialHex,
        drepIsScript: target.isScript,
        origin: window.location.origin,
      });
      setPhase({ status: 'success', txHash });
      // A signed-in account with a linked stake wallet can be told right away.
      // The server checks whether this wallet is that account's own and answers
      // 'wallet_mismatch' when it is not, which turns into the sign-in offer.
      if (viewer.signedIn && viewer.hasStakeAddr) {
        void reportDelegation(txHash, rewardAddressHex);
      }
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
    }
  }

  /** Tells the server what this wallet just delegated to. Never throws: the
   *  delegation is already on chain, only the follow-up can fail. */
  async function reportDelegation(txHash: string, rewardAddressHex: string) {
    try {
      const res = await fetch('/api/delegation/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedDrepId: target.drepId, expectedTx: txHash, rewardAddressHex }),
      });
      const data = (await res.json().catch(() => null)) as { expectation?: string } | null;
      if (res.ok && data?.expectation === 'recorded') setTrackState('recorded');
      else if (res.ok && data?.expectation === 'wallet_mismatch') setTrackState('wallet_mismatch');
      else setTrackState('error');
    } catch {
      setTrackState('error');
    }
  }

  /** Signs in as a delegator with the wallet that just delegated, handing the
   *  server the delegation so the dashboard shows it and no "your delegation
   *  changed" notification is sent for the person's own action. */
  async function handleTrackSignIn(txHash: string) {
    const api = apiRef.current;
    if (!api || signingIn) return;
    setSigningIn(true);
    setSignInError(null);
    // The tx WalletApi and the login's CIP-30 surface are the same object at
    // runtime. Their declared types differ (readonly arrays, signData shape).
    const result = await loginWithWallet(api as unknown as Parameters<typeof loginWithWallet>[0], 'delegator', network, undefined, {
      expectedDrepId: target.drepId,
      expectedTx: txHash,
      ref: refFromUrl() ?? source,
    });
    setSigningIn(false);
    if (!result.ok) {
      setSignInError(result.error ?? 'Sign-in failed. Please try again.');
      return;
    }
    // On /match/ the quiz answers live in component state, so a reload would
    // discard them at exactly the moment someone acted on the result. Known
    // limitation of skipping it: the page's header and the `viewer` prop of the
    // OTHER result rows still describe an anonymous visitor, so delegating to a
    // second DRep in the same quiz session offers the sign-in once more. It
    // signs the same wallet into the same account, so the cost is one extra
    // click, not a wrong account.
    if (source === 'match') setSignedInNow(true);
    else window.location.reload();
  }

  return (
    <div className="drep-dialog__backdrop">
      <div ref={panelRef} className="drep-dialog" role="dialog" aria-modal="true" aria-labelledby="drep-dialog-title" tabIndex={-1}>
        <div className="drep-dialog__head">
          <h2 id="drep-dialog-title" className="drep-dialog__title">Delegate voting power</h2>
          <button type="button" className="drep-dialog__close" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="drep-dialog__target">
          To <strong>{target.name}</strong>
          <span className="drep-dialog__target-id" title={target.drepId}>{shortId}</span>
          <CopyButton value={target.drepId} label="Copy DRep id" />
        </p>

        {phase.status === 'success' ? (
          <div className="callout callout--success" role="status">
            <div className="callout__body">
              <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Delegation submitted</p>
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
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                Your voting power moves to this DRep once the transaction is confirmed.
              </p>
              {signedInNow ? (
                <p style={{ margin: '0.75rem 0 0' }}>
                  <a href="/my-drep/" style={{ color: 'var(--accent)' }}>See what this DRep does</a>
                </p>
              ) : (
                <TrackingBlock
                  offer={trackingOffer(viewer, trackState)}
                  busy={signingIn}
                  error={signInError}
                  onSignIn={() => handleTrackSignIn(phase.txHash)}
                />
              )}
            </div>
          </div>
        ) : (
          <>
            <p className="drep-dialog__note">
              Delegating your voting power is an on-chain transaction. Your wallet signs and submits a small
              vote-delegation certificate (network fee only, no deposit). dreptalk.com never sees your keys.{' '}
              {/* New tab on purpose: in-place navigation would discard the dialog's wallet state mid-flow. */}
              <a href="/help/delegate-to-a-drep/" target="_blank" rel="noopener">How delegating works</a>
            </p>

            {wallets.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>
                No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                {(phase.status === 'idle' || phase.status === 'connecting' || phase.status === 'error') && (
                  <>
                    <WalletConnection
                      wallets={wallets}
                      selected={selected}
                      onSelect={setSelected}
                      disabled={busy}
                      label="Signing wallet"
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void handleConnect()}
                      disabled={busy}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      {phase.status === 'connecting' ? 'Connecting...' : 'Connect wallet'}
                    </button>
                  </>
                )}

                {phase.status === 'confirm' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleDelegate(phase.rewardAddressHex)}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    Delegate to this DRep
                  </button>
                )}

                {phase.status === 'submitting' && (
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                    Please review and approve the transaction in your wallet.
                  </p>
                )}

                {phase.status === 'error' && (
                  <div className="callout callout--error" role="alert">
                    <div className="callout__body">{phase.message}</div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The follow-up offer under a successful delegation. Copy only: which variant
 *  to show is decided by trackingOffer, which is unit tested on its own. */
function TrackingBlock({
  offer,
  busy,
  error,
  onSignIn,
}: {
  offer: ReturnType<typeof trackingOffer>;
  busy: boolean;
  error: string | null;
  onSignIn: () => void;
}) {
  const note = { margin: '0.75rem 0 0', fontSize: '0.875rem' } as const;

  if (offer.kind === 'sign-in' || offer.kind === 'switch-account') {
    return (
      <div style={note}>
        <p style={{ margin: '0 0 0.5rem' }}>
          {offer.kind === 'switch-account'
            ? 'This is not the wallet linked to your account. Signing in with it switches you to that wallet\'s own account, where this delegation can be tracked.'
            : 'Want to follow how this DRep votes? Sign in with this wallet and DRepTalk keeps track of your delegation.'}
        </p>
        <button type="button" className="btn btn-primary" onClick={onSignIn} disabled={busy}>
          {busy
            ? 'Signing in...'
            : offer.kind === 'switch-account'
              ? 'Sign in with this wallet'
              : 'Follow how this DRep votes'}
        </button>
        {error && <p style={{ margin: '0.5rem 0 0', color: 'var(--danger, #b00)' }}>{error}</p>}
      </div>
    );
  }

  if (offer.kind === 'tracked') {
    return (
      <p style={note}>
        DRepTalk is tracking this delegation. <a href="/my-drep/" style={{ color: 'var(--accent)' }}>See what this DRep does</a>
      </p>
    );
  }

  if (offer.kind === 'link-wallet') {
    return (
      <p style={note}>
        To follow this delegation, link your stake wallet in your{' '}
        <a href="/settings/account/" style={{ color: 'var(--accent)' }}>account settings</a>.
      </p>
    );
  }

  if (offer.kind === 'retry') {
    return (
      <p style={note}>
        Your delegation is on chain. DRepTalk could not record it just now, it will pick it up on the next refresh.
      </p>
    );
  }

  return <p style={note}>Recording your delegation...</p>;
}
