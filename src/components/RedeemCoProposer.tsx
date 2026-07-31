// React island: lets a logged-out invite holder redeem a co-proposer invite
// link. Reuses the wallet-connect pattern (useCardanoWallets, WalletConnection)
// and the reward-address signData approach the proposer/delegator login path
// uses (see redeemCoProposer.ts). Rendered on /co-proposer/redeem, which
// resolves the invite server-side and passes only the opaque code down; a
// grantId is never sent to or received from the client (see coProposerRedeem.ts).
import { useState } from 'react';
import { redeemCoProposerInvite, friendlyRedeemError } from '@/lib/auth/redeemCoProposer.js';
import { MAX_CO_PROPOSER_NAME } from '@/lib/auth/coProposerRedeem.js';
import type { WalletApi } from '@/lib/auth/walletLogin.js';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import WalletConnection from '@/components/WalletConnection.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { cardStyle, stepHeadingStyle, fieldLabelStyle, inputStyle } from '@/components/signInStyles.js';

// Where a successful redemption lands: the same start page a normal sign-in
// lands on (see signInStyles.ts's POST_LOGIN_DEST).
const POST_REDEEM_DEST = '/home/';

interface RedeemCoProposerProps {
  network: CardanoNetwork;
  /** The invite's bearer code from the URL. Never a grantId. */
  code: string;
}

type RedeemState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'awaiting-signature' }
  | { status: 'joined' }
  | { status: 'error'; message: string };

// ---- Icons ------------------------------------------------------------------

const IconWallet = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20" />
    <circle cx="17" cy="15" r="1" fill="currentColor" />
  </svg>
);

const IconShieldCheck = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
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

// ---- Main island --------------------------------------------------------------

export default function RedeemCoProposer({ network, code }: RedeemCoProposerProps) {
  const [name, setName] = useState('');
  const [redeemState, setRedeemState] = useState<RedeemState>({ status: 'idle' });
  const { wallets, selected: selectedWallet, setSelected: setSelectedWallet, scanning } = useCardanoWallets();

  const busy = redeemState.status === 'connecting' || redeemState.status === 'awaiting-signature';
  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && trimmedName.length <= MAX_CO_PROPOSER_NAME && !busy;

  async function doRedeem() {
    if (!canSubmit) return;
    const walletInfo = wallets.find((w) => w.key === selectedWallet);
    if (!walletInfo) return;

    setRedeemState({ status: 'connecting' });
    let api: WalletApi;
    try {
      api = await walletInfo.raw.enable();
    } catch {
      setRedeemState({ status: 'error', message: 'Wallet connection was rejected.' });
      return;
    }

    setRedeemState({ status: 'awaiting-signature' });
    const result = await redeemCoProposerInvite(api, network, code, trimmedName);

    if (result.ok) {
      rememberWallet(selectedWallet);
      setRedeemState({ status: 'joined' });
      window.location.assign(POST_REDEEM_DEST);
    } else {
      setRedeemState({ status: 'error', message: friendlyRedeemError(result.error, network) });
    }
  }

  if (redeemState.status === 'joined') {
    return (
      <div style={cardStyle}>
        <p role="status" style={{ margin: 0, fontSize: '0.9375rem' }}>
          You have joined. Taking you to your home page...
        </p>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      {/* Step 1: name */}
      <div>
        <span style={stepHeadingStyle}>1. Your name</span>
        <label htmlFor="co-proposer-name" style={fieldLabelStyle}>
          How should your posts be attributed?
        </label>
        <input
          id="co-proposer-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={MAX_CO_PROPOSER_NAME}
          placeholder="Your name"
          disabled={busy}
          style={inputStyle}
        />
      </div>

      {/* Step 2: wallet */}
      <div>
        <span style={stepHeadingStyle}>2. Your wallet</span>
        {wallets.length === 0 ? (
          <p role="status" aria-live="polite" style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
            {scanning
              ? 'Looking for a wallet extension...'
              : 'No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).'}
          </p>
        ) : (
          <WalletConnection wallets={wallets} selected={selectedWallet} onSelect={setSelectedWallet} disabled={busy} label="" />
        )}
      </div>

      <button
        type="button"
        className="btn btn-primary"
        onClick={doRedeem}
        disabled={!canSubmit || wallets.length === 0}
        style={{ width: '100%', padding: '0.65rem 1rem', fontSize: '0.9375rem', opacity: !canSubmit || wallets.length === 0 ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
      >
        {IconWallet}
        {redeemState.status === 'connecting'
          ? 'Connecting...'
          : redeemState.status === 'awaiting-signature'
            ? 'Please sign in your wallet...'
            : 'Sign and join'}
      </button>

      <p style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', margin: 0, fontSize: '0.8125rem', color: 'var(--muted)', textAlign: 'center' }}>
        {IconShieldCheck}
        You will sign a one-time message. This does not submit a transaction or cost fees.
      </p>

      {redeemState.status === 'error' && (
        <div className="callout callout--error" role="alert">
          {IconError}
          <div className="callout__body">{redeemState.message}</div>
        </div>
      )}
    </div>
  );
}
