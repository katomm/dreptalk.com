// React island: lets a signed-in writer (DRep, SPO, CC member, proposer) link
// their stake wallet to their account, then opt into ongoing delegation
// tracking on their home page. Reuses the wallet-connect pattern
// (useCardanoWallets, WalletConnection) and the reward-address signData
// approach the proposer/delegator login path uses (see linkStakeWallet.ts).
// Rendered on /settings, writer-gated by the caller (see settings.astro).
import { useState } from 'react';
import { linkStakeWallet, trackDelegation } from '@/lib/auth/linkStakeWallet.js';
import type { WalletApi } from '@/lib/auth/walletLogin.js';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import WalletConnection from '@/components/WalletConnection.js';
import { networkMismatchMessage, WALLET_NETWORK_MISMATCH } from '@/lib/wallet/networkGuard.js';
import { delegationLabel } from '@/lib/delegation/format.js';
import { truncateIdMiddle } from '@/lib/forum/view.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { cardStyle, stepHeadingStyle, linkBtnStyle } from '@/components/signInStyles.js';

// ---- Types ------------------------------------------------------------------

interface InitialTracking {
  resolutionStatus: 'pending' | 'resolved';
  delegationType: string | null;
  drepId: string | null;
  drepName: string | null;
}

interface LinkStakeWalletProps {
  network: CardanoNetwork;
  /** Already-linked stake address, or null when nothing is linked yet. */
  initialStakeAddr: string | null;
  /** Existing tracking row for the linked wallet, or null when not tracked yet. */
  initialTracking: InitialTracking | null;
}

type LinkState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'awaiting-signature' }
  | { status: 'linked'; stakeAddr: string }
  | { status: 'error'; message: string };

type TrackState =
  | { status: 'prompt' }
  | { status: 'submitting' }
  | { status: 'tracked'; resolutionStatus: 'pending' | 'resolved'; delegationType: string | null; drepId: string | null; drepName: string | null }
  | { status: 'declined' }
  | { status: 'error'; message: string };

// ---- Error mapping ----------------------------------------------------------

// Maps the terse server error codes from link-challenge/link-stake to clear,
// human-readable sentences. Mirrors friendlyLoginError in SignIn.tsx.
function friendlyLinkError(error: string | undefined, network: CardanoNetwork): string {
  const e = (error ?? '').toLowerCase();
  if (!e) return 'Linking failed. Please try again.';

  if (e.includes(WALLET_NETWORK_MISMATCH)) return networkMismatchMessage(network);
  if (e.includes('already linked to another account')) {
    return 'That stake wallet is already linked to another account. Please use a different wallet.';
  }
  if (e.includes('already has a stake wallet')) {
    return 'Your account already has a stake wallet linked.';
  }
  if (e.includes('nonce')) {
    return 'Your link challenge expired. Please try again.';
  }
  if (e.includes('address type mismatch') || e.includes('invalid address in signature')) {
    return 'This wallet did not sign with a stake address. Please pick the wallet whose stake key you want to link.';
  }
  if (e.includes('signature verification')) {
    return 'We could not verify your signature. Please try signing again.';
  }
  if (e.includes('invalid request')) {
    return 'Something was off with the request. Please try again.';
  }
  if (e.includes('rate_limited')) {
    return 'Too many attempts. Please wait a bit and try again.';
  }
  if (e.includes('unauthorized') || e.includes('forbidden')) {
    return 'Please sign in again.';
  }
  if (e.includes('service unavailable') || e.includes('internal')) {
    return 'Linking failed, the service may be busy. Please try again.';
  }
  const msg = error!.charAt(0).toUpperCase() + error!.slice(1);
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}

// ---- Icons ------------------------------------------------------------------

const IconWallet = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20" />
    <circle cx="17" cy="15" r="1" fill="currentColor" />
  </svg>
);

const IconCheck = (
  <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const IconError = (
  <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

// ---- Track opt-in panel ------------------------------------------------------

function TrackPanel({ trackState, onSubmit }: { trackState: TrackState; onSubmit: (answer: 'yes' | 'no') => void }) {
  if (trackState.status === 'declined') return null;

  if (trackState.status === 'tracked') {
    const state =
      trackState.delegationType === 'drep' && trackState.drepId
        ? ({ type: 'drep', drepId: trackState.drepId } as const)
        : trackState.delegationType === 'abstain'
          ? ({ type: 'abstain' } as const)
          : trackState.delegationType === 'no_confidence'
            ? ({ type: 'no_confidence' } as const)
            : ({ type: 'none' } as const);
    return (
      <div className="callout callout--success" role="status">
        {IconCheck}
        <div className="callout__body">
          {trackState.resolutionStatus === 'resolved' ? (
            <>Now tracking your delegation. You are currently delegated to {delegationLabel(state, trackState.drepName)}.</>
          ) : (
            <>Now tracking your delegation. We are checking your current delegation; it will show up on your home page shortly.</>
          )}
        </div>
      </div>
    );
  }

  if (trackState.status === 'error') {
    return (
      <div className="callout callout--error" role="alert">
        {IconError}
        <div className="callout__body">
          {trackState.message}{' '}
          <button type="button" onClick={() => onSubmit('yes')} style={linkBtnStyle}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const busy = trackState.status === 'submitting';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <p style={{ margin: 0, fontSize: '0.9375rem' }}>Track this wallet&apos;s delegation on your home?</p>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onSubmit('yes')}
          disabled={busy}
          style={{ padding: '0.45rem 1rem', fontSize: '0.875rem', opacity: busy ? 0.7 : 1 }}
        >
          {busy ? 'Setting up...' : 'Yes, track it'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onSubmit('no')}
          disabled={busy}
          style={{ padding: '0.45rem 1rem', fontSize: '0.875rem' }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

// ---- Main island --------------------------------------------------------------

export default function LinkStakeWallet({ network, initialStakeAddr, initialTracking }: LinkStakeWalletProps) {
  const [linkState, setLinkState] = useState<LinkState>(
    initialStakeAddr ? { status: 'linked', stakeAddr: initialStakeAddr } : { status: 'idle' },
  );
  const [trackState, setTrackState] = useState<TrackState>(
    initialTracking
      ? {
          status: 'tracked',
          resolutionStatus: initialTracking.resolutionStatus,
          delegationType: initialTracking.delegationType,
          drepId: initialTracking.drepId,
          drepName: initialTracking.drepName,
        }
      : { status: 'prompt' },
  );
  const { wallets, selected: selectedWallet, setSelected: setSelectedWallet, scanning } = useCardanoWallets();

  const busy = linkState.status === 'connecting' || linkState.status === 'awaiting-signature';

  async function doLink() {
    const walletInfo = wallets.find((w) => w.key === selectedWallet);
    if (!walletInfo) return;

    setLinkState({ status: 'connecting' });
    let api: WalletApi;
    try {
      api = await walletInfo.raw.enable();
    } catch {
      setLinkState({ status: 'error', message: 'Wallet connection was rejected.' });
      return;
    }

    setLinkState({ status: 'awaiting-signature' });
    const result = await linkStakeWallet(api, network);

    if (result.ok) {
      rememberWallet(selectedWallet);
      // The server does not echo the stake address back, so nothing to show
      // beyond the success state itself; the track prompt below is the next step.
      setLinkState({ status: 'linked', stakeAddr: '' });
      setTrackState({ status: 'prompt' });
    } else {
      setLinkState({ status: 'error', message: friendlyLinkError(result.error, network) });
    }
  }

  async function doTrack(answer: 'yes' | 'no') {
    if (answer === 'no') {
      setTrackState({ status: 'declined' });
      return;
    }
    setTrackState({ status: 'submitting' });
    const result = await trackDelegation();
    if (result.ok) {
      setTrackState({
        status: 'tracked',
        resolutionStatus: result.status ?? 'pending',
        delegationType: result.delegationType ?? null,
        drepId: result.drepId ?? null,
        drepName: null,
      });
    } else {
      setTrackState({
        status: 'error',
        message: friendlyLinkError(result.error, network) || 'Could not start tracking. Please try again.',
      });
    }
  }

  // Already linked (from a prior visit or just now): show the linked state and
  // the tracking opt-in/status, no wallet picker needed.
  if (linkState.status === 'linked') {
    return (
      <div style={cardStyle}>
        <div className="callout callout--success" role="status">
          {IconCheck}
          <div className="callout__body">
            Stake wallet linked
            {linkState.stakeAddr && (
              <span style={{ display: 'block', marginTop: '0.25rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.8125rem', color: 'var(--muted)' }}>
                {truncateIdMiddle(linkState.stakeAddr)}
              </span>
            )}
          </div>
        </div>
        <TrackPanel trackState={trackState} onSubmit={doTrack} />
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div>
        <span style={stepHeadingStyle}>Link your stake wallet</span>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.875rem', color: 'var(--muted)', lineHeight: 1.5 }}>
          Prove ownership of your stake wallet to link it to this account. This lets you track your own delegation on
          your home page. You will sign a one-time message; this does not submit a transaction or cost fees.
        </p>
      </div>

      {wallets.length === 0 ? (
        <p role="status" aria-live="polite" style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
          {scanning
            ? 'Looking for a wallet extension...'
            : 'No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).'}
        </p>
      ) : (
        <>
          <WalletConnection wallets={wallets} selected={selectedWallet} onSelect={setSelectedWallet} disabled={busy} label="" />

          <button
            type="button"
            className="btn btn-primary"
            onClick={doLink}
            disabled={busy}
            style={{ width: '100%', padding: '0.65rem 1rem', fontSize: '0.9375rem', opacity: busy ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
          >
            {IconWallet}
            {linkState.status === 'connecting'
              ? 'Connecting...'
              : linkState.status === 'awaiting-signature'
                ? 'Please sign in your wallet...'
                : 'Link stake wallet'}
          </button>
        </>
      )}

      {linkState.status === 'error' && (
        <div className="callout callout--error" role="alert">
          {IconError}
          <div className="callout__body">
            {linkState.message}
            <div style={{ marginTop: '0.6rem' }}>
              <button type="button" onClick={() => setLinkState({ status: 'idle' })} style={linkBtnStyle}>
                Try again
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
