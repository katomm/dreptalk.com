// The last section of /ga/new: pick a wallet, connect it, see the deposit
// next to what the wallet actually holds, and submit. Everything above it is
// drafted without a wallet, which is the whole point of the section existing
// at the end rather than as a gate at the top.
//
// Presentational: it owns no state of its own. Connecting, reading the
// balance and submitting are the island's handlers, the readiness reasons come
// from readiness.ts, and the Review button is passed in as a slot so this
// component does not need to know what a preview is.
import type { CSSProperties, ReactNode } from 'react';
import type { CardanoWalletInfo } from '@/lib/wallet/useCardanoWallets.js';
import type { DepositState, WalletState } from '@/lib/governance/govActionFormState.js';
import type { ReadinessReason } from '@/lib/governance/readiness.js';
import { formatAdaPlain } from '@/lib/format/ada.js';
import WalletConnection from '@/components/WalletConnection.js';
import ReadinessList from '@/components/govAction/ReadinessList.js';
import { ErrorIcon, InfoIcon } from '@/components/govAction/icons.js';
import { linkButtonStyle } from '@/components/drepFormStyles.js';

export interface SignAndSubmitProps {
  wallets: CardanoWalletInfo[];
  selected: string;
  onSelect: (key: string) => void;
  wallet: WalletState;
  deposit: DepositState;
  reasons: ReadinessReason[];
  onConnect: () => void;
  /** Re-reads the wallet balance after a top-up. */
  onCheckAgain: () => void;
  submitting: boolean;
  /** The Review button, which readiness never disables. */
  reviewSlot?: ReactNode;
  /** A failed connect attempt: the form above stays exactly as it was. */
  connectError: string | null;
  /** A failed submit, shown under the button next to its retry. */
  submitError: string | null;
  onUseDifferentWallet: () => void;
}

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.875rem',
  borderTop: '1px solid var(--border)',
  paddingTop: '1.25rem',
};

/**
 * The one line under the connected wallet, in the four states it can be in.
 * A failed read says so instead of claiming to still be reading: the
 * readiness list says the balance is unknown, and the two must not
 * contradict each other.
 */
function balanceLine(deposit: DepositState, wallet: WalletState): string | null {
  if (wallet.status !== 'connected') return null;
  const balance = wallet.balance;
  if (balance.status === 'loading') return 'Reading the wallet balance...';
  if (balance.status === 'error') return balance.message || 'Could not read the wallet balance';
  if (deposit.status !== 'ready') return `Wallet ${formatAdaPlain(balance.lovelace)} tADA`;
  return `Deposit ${formatAdaPlain(deposit.lovelace)} tADA, wallet ${formatAdaPlain(balance.lovelace)} tADA`;
}

export default function SignAndSubmit(props: SignAndSubmitProps) {
  const { wallet, wallets, deposit, reasons, submitting } = props;
  const connecting = wallet.status === 'connecting';
  const connected = wallet.status === 'connected';
  const balanceKnown = connected && wallet.balance.status !== 'loading';
  const figures = balanceLine(deposit, wallet);

  return (
    <div style={sectionStyle}>
      <h2 style={{ margin: 0, fontSize: '1.0625rem' }}>Sign and submit</h2>

      {wallets.length === 0 ? (
        <div className="callout callout--info" role="status">
          <InfoIcon />
          <div className="callout__body">
            No Cardano wallet extension detected. Everything above is yours to draft and keep, but
            submitting needs a wallet. Please install one (e.g. Lace, Eternl, Typhon) and reload.
          </div>
        </div>
      ) : (
        <>
          <WalletConnection
            wallets={wallets}
            selected={props.selected}
            onSelect={props.onSelect}
            disabled={connecting || submitting || connected}
            label="Signing wallet"
          />

          {!connected && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={props.onConnect}
              disabled={connecting || submitting}
              style={{ alignSelf: 'flex-start' }}
            >
              {connecting ? 'Connecting...' : props.connectError ? 'Try again' : 'Connect wallet'}
            </button>
          )}

          {props.connectError && (
            <div className="callout callout--error" role="alert">
              <ErrorIcon />
              <div className="callout__body">{props.connectError}</div>
            </div>
          )}

          {connected && (
            <p style={{ margin: 0, fontSize: '0.875rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              <span>{figures}</span>
              {balanceKnown && (
                <button type="button" onClick={props.onCheckAgain} disabled={submitting} style={linkButtonStyle}>
                  Check again
                </button>
              )}
              <button type="button" onClick={props.onUseDifferentWallet} disabled={submitting} style={linkButtonStyle}>
                Use a different wallet
              </button>
            </p>
          )}
        </>
      )}

      <ReadinessList reasons={reasons} />

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
        {props.reviewSlot}
        {/* A real submit button inside the island's form, so the browser runs
            its own validation (the reference URL fields above have rules of
            their own) before the handler publishes anything. */}
        <button type="submit" className="btn btn-primary" disabled={submitting || reasons.length > 0}>
          {submitting ? 'Awaiting wallet...' : 'Submit proposal'}
        </button>
      </div>

      {props.submitError && (
        <div className="callout callout--error" role="alert">
          <ErrorIcon />
          <div className="callout__body">
            {props.submitError}{' '}
            <button type="button" onClick={props.onUseDifferentWallet} style={linkButtonStyle}>
              Use a different wallet
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
