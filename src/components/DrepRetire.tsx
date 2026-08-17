// React island: the DRep "Danger Zone" on the settings page. Split out of
// DrepSettings so the destructive retire action sits on its own at the very
// bottom of the page, below the metadata form and the stake-wallet link. The
// wallet connect + identity verification use the same shared helper as
// DrepSettings (connectVerifiedDrep), so the two manage flows cannot drift.
import { useState, useRef } from 'react';
import { CopyButton } from '@/components/CopyButton.js';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import { retireDRep } from '@/lib/governance/drepTx.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { connectVerifiedDrep, type EnabledWalletApi } from '@/lib/wallet/drepWalletConnect.js';
import WalletConnection from '@/components/WalletConnection.js';

type Phase =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; txHash: string }
  | { status: 'error'; message: string };

export interface DrepRetireProps {
  // Resolved at build time from the .astro shell; defaults to preprod.
  network?: CardanoNetwork;
  /** The session's drep id; the connected wallet must derive the same one. */
  expectedDrepId: string;
}

export default function DrepRetire({ network = 'preprod', expectedDrepId }: DrepRetireProps) {
  const { wallets, selected, setSelected } = useCardanoWallets({ preferCip95: true });
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [confirmRetire, setConfirmRetire] = useState(false);

  // Caches the enabled CIP-30 api (enable() is idempotent but each call is an
  // extension IPC round trip).
  const enabledApiRef = useRef<EnabledWalletApi | null>(null);

  // Connects the selected wallet via the shared manage-flow helper (CIP-95
  // enable, network guard, identity derivation + match against the signed-in
  // DRep). Returns null after setting an error phase when any step fails.
  async function connectAndVerify(): Promise<{ api: EnabledWalletApi; drepKeyHash: Uint8Array } | null> {
    const walletInfo = wallets.find((w) => w.key === selected);
    if (!walletInfo) {
      setPhase({ status: 'error', message: 'Please select a wallet.' });
      return null;
    }

    try {
      const connected = await connectVerifiedDrep({
        rawWallet: walletInfo.raw,
        network,
        expectedDrepId,
        cachedApi: enabledApiRef.current,
      });
      enabledApiRef.current = connected.api;
      // The right wallet for this DRep: remember it as the future default.
      rememberWallet(selected);
      return connected;
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return null;
    }
  }

  // Retire flow: unreg_drep certificate; checkbox-gated, wallet is the final
  // confirmation. No metadata involved.
  async function handleRetire() {
    setPhase({ status: 'submitting' });

    try {
      const connected = await connectAndVerify();
      if (!connected) return;

      const { txHash } = await retireDRep({
        walletApi: connected.api,
        network,
        drepKeyHash: connected.drepKeyHash,
        origin: window.location.origin,
      });

      setPhase({ status: 'success', txHash });
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
    }
  }

  const busy = phase.status === 'submitting';

  if (phase.status === 'success') {
    return (
      <div style={{ maxWidth: '32rem' }}>
        <div className="callout callout--success" role="status">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Retirement submitted</p>
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
              Your DRep deposit is refunded once the transaction is confirmed. Your forum account and posts are unaffected.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const selectedWalletName = wallets.find((w) => w.key === selected)?.name ?? null;

  return (
    <section
      style={{
        maxWidth: '32rem',
        border: '1px solid var(--danger)',
        borderRadius: 'var(--radius)',
        padding: '1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.875rem',
      }}
    >
      <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        Danger Zone
      </h3>

      <div>
        <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Retire as DRep</p>
        <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', color: 'var(--muted)' }}>
          Retiring submits a deregistration certificate to the Cardano chain. Your 500 ADA deposit is
          refunded once it confirms, and everyone who delegated their voting power to you loses that
          delegation. You can register again later.
        </p>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>
          This does <strong>not</strong> delete anything on DRepTalk: your forum account, posts, and
          profile page remain.
        </p>
      </div>

      {wallets.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
          No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon) to retire your DRep.
        </p>
      ) : (
        <>
          <WalletConnection
            wallets={wallets}
            selected={selected}
            onSelect={setSelected}
            disabled={busy}
            requiresCip95
            note="This wallet will sign the deregistration; it must be the one you signed in with."
          />

          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.875rem' }}>
            <input
              type="checkbox"
              checked={confirmRetire}
              onChange={(e) => setConfirmRetire(e.target.checked)}
              disabled={busy}
              style={{ marginTop: '0.15rem' }}
            />
            <span>I understand this deregisters my DRep on-chain.</span>
          </label>

          <div>
            <button
              type="button"
              disabled={busy || !confirmRetire}
              onClick={() => void handleRetire()}
              style={{
                padding: '0.5rem 1rem',
                background: 'transparent',
                color: 'var(--danger)',
                border: '1px solid var(--danger)',
                borderRadius: '0.375rem',
                fontSize: '0.9375rem',
                fontWeight: 500,
                cursor: busy || !confirmRetire ? 'not-allowed' : 'pointer',
                opacity: busy || !confirmRetire ? 0.6 : 1,
              }}
            >
              {busy ? 'Awaiting wallet...' : 'Retire DRep'}
            </button>
            {selectedWalletName && !busy && (
              <span style={{ marginLeft: '0.875rem', fontSize: '0.8125rem', color: 'var(--muted)' }}>
                You'll be asked to sign with {selectedWalletName}.
              </span>
            )}
          </div>

          {busy && (
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
              Please review and approve the deregistration in your wallet.
            </p>
          )}
        </>
      )}

      {phase.status === 'error' && (
        <div className="callout callout--error" role="alert">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div className="callout__body">
            {phase.message}
            {' '}
            <button
              type="button"
              onClick={() => setPhase({ status: 'idle' })}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}
            >
              Try again
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
