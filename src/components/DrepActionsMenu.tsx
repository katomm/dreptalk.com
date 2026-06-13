// React island: per-row actions menu for the /dreps table, plus the
// non-custodial vote-delegation dialog it opens.
//
// The table itself is server-rendered Astro (good for SEO and a cheap first
// paint). Each row renders a plain `<button data-drep-action ...>` carrying the
// DRep identity in data-attributes. This single island mounts once, listens for
// clicks on those buttons (they live OUTSIDE the island's React root, so only a
// native document listener can catch them), and opens a small popover anchored
// to the clicked button.
//
// "Delegate voting power" opens DelegateDialog, which runs the same
// non-custodial wallet flow as DRepService: the server never sees a key; the
// wallet signs and submits the vote_deleg certificate. The Evolution SDK is
// pulled in lazily (dynamic import at submit time) so the dreps list does not
// ship the heavy tx bundle on first load.
import { useEffect, useRef, useState } from 'react';
import { useCardanoWallets } from '@/lib/wallet/useCardanoWallets.js';
import WalletPicker from '@/components/WalletPicker.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import type { WalletApi } from '@/lib/governance/drepTx.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import { drepPath } from '@/lib/drep/profile.js';
import { truncateIdMiddle } from '@/lib/forum/view.js';

// The enabled CIP-30 surface we use here: the tx WalletApi plus getNetworkId,
// which the network guard reads (enable() returns the full object at runtime).
type EnabledWalletApi = WalletApi & { getNetworkId(): Promise<number> };

// Identity of the DRep a row's action menu targets. credentialHex is the 28-byte
// credential the dreps table stores (Koios `hex`); null means we could not
// resolve it, so delegation is offered as disabled.
interface Target {
  drepId: string;
  /** SEO profile slug when assigned; the profile link prefers it over the id. */
  slug: string | null;
  name: string;
  credentialHex: string | null;
  isScript: boolean;
}

interface Props {
  // Resolved at build/SSR time from the deployment's network; defaults to preprod.
  network?: CardanoNetwork;
}

function targetFromButton(btn: HTMLElement): Target {
  return {
    drepId: btn.dataset.drepId ?? '',
    slug: btn.dataset.drepSlug || null,
    name: btn.dataset.drepName ?? '',
    credentialHex: btn.dataset.drepCred || null,
    isScript: btn.dataset.drepScript === '1',
  };
}

type Menu = { target: Target; right: number; top: number } | null;

export default function DrepActionsMenu({ network = 'preprod' }: Props) {
  const [menu, setMenu] = useState<Menu>(null);
  const [dialogTarget, setDialogTarget] = useState<Target | null>(null);
  const [copied, setCopied] = useState(false);

  // The row action buttons are server HTML outside this island's React root, so
  // a native document listener is the only way to catch their clicks. A second
  // role of the same listener: clicking anywhere outside the open popover closes
  // it. Scroll/resize also close it, since the popover is pinned to a viewport
  // coordinate that those invalidate.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      const btn = el?.closest('[data-drep-action]') as HTMLElement | null;
      if (btn) {
        e.preventDefault();
        const rect = btn.getBoundingClientRect();
        setCopied(false);
        setMenu({ target: targetFromButton(btn), right: window.innerWidth - rect.right, top: rect.bottom + 4 });
        return;
      }
      if (!el?.closest('[data-drep-menu]')) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, []);

  function openDelegate(target: Target) {
    setMenu(null);
    setDialogTarget(target);
  }

  async function copyId(drepId: string) {
    try {
      await navigator.clipboard.writeText(drepId);
      setCopied(true);
    } catch {
      // Clipboard can be blocked (no permission / insecure context); ignore.
    }
  }

  return (
    <>
      {menu && (
        <div
          data-drep-menu
          className="drep-menu"
          role="menu"
          style={{ position: 'fixed', top: menu.top, right: menu.right }}
        >
          <button
            type="button"
            role="menuitem"
            className="drep-menu__item"
            disabled={!menu.target.credentialHex}
            onClick={() => openDelegate(menu.target)}
          >
            Delegate voting power
            {!menu.target.credentialHex && (
              <span className="drep-menu__hint">unavailable</span>
            )}
          </button>
          <a role="menuitem" className="drep-menu__item" href={drepPath(menu.target)}>
            View profile
          </a>
          <button
            type="button"
            role="menuitem"
            className="drep-menu__item"
            onClick={() => void copyId(menu.target.drepId)}
          >
            {copied ? 'Copied' : 'Copy DRep ID'}
          </button>
        </div>
      )}

      {dialogTarget && (
        <DelegateDialog
          target={dialogTarget}
          network={network}
          onClose={() => setDialogTarget(null)}
        />
      )}
    </>
  );
}

type DelegatePhase =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'confirm'; rewardAddressHex: string }
  | { status: 'submitting'; rewardAddressHex: string }
  | { status: 'success'; txHash: string }
  | { status: 'error'; message: string };

function DelegateDialog({
  target,
  network,
  onClose,
}: {
  target: Target;
  network: CardanoNetwork;
  onClose: () => void;
}) {
  const { wallets, selected, setSelected } = useCardanoWallets();
  const [phase, setPhase] = useState<DelegatePhase>({ status: 'idle' });
  const apiRef = useRef<EnabledWalletApi | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const busy = phase.status === 'connecting' || phase.status === 'submitting';

  // Escape or a click outside the panel closes the dialog, but never mid-flight
  // (connecting/submitting) so a wallet round-trip is not orphaned. Outside-click
  // is a document mousedown test against the panel rather than a backdrop onClick,
  // which keeps the static backdrop free of interaction handlers.
  useEffect(() => {
    const dismissable = !busy;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (dismissable && panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [busy, onClose]);

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
      // dreps list never ships the heavy bundle just to render the table.
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
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
    }
  }

  return (
    <div className="drep-dialog__backdrop">
      <div ref={panelRef} className="drep-dialog" role="dialog" aria-modal="true" aria-labelledby="drep-dialog-title">
        <div className="drep-dialog__head">
          <h2 id="drep-dialog-title" className="drep-dialog__title">Delegate voting power</h2>
          <button type="button" className="drep-dialog__close" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="drep-dialog__target">
          To <strong>{target.name}</strong>
          <span className="drep-dialog__target-id">{shortId}</span>
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
              </p>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                Your voting power moves to this DRep once the transaction is confirmed.
              </p>
            </div>
          </div>
        ) : (
          <>
            <p className="drep-dialog__note">
              Delegating your voting power is an on-chain transaction. Your wallet signs and submits a small
              vote-delegation certificate (network fee only, no deposit). dreptalk.com never sees your keys.
            </p>

            {wallets.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>
                No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                {(phase.status === 'idle' || phase.status === 'connecting' || phase.status === 'error') && (
                  <>
                    <WalletPicker
                      wallets={wallets}
                      selected={selected}
                      onSelect={setSelected}
                      disabled={busy}
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
