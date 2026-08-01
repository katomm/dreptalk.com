// React island: settings panel for a signed-in DRep.
//
// Inverse of DRepService: assumes an already-registered DRep (the session's
// drep id arrives as expectedDrepId) and updates the CIP-119 metadata anchor
// (update_drep, no deposit). The wallet signs and submits; the server only
// hosts the metadata document and proxies Koios. The destructive retire action
// lives in its own island (DrepRetire), rendered last on the settings page.
import { useState, useRef } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { CopyButton } from '@/components/CopyButton.js';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import { updateDRepMetadata } from '@/lib/governance/drepTx.js';
import type { WalletApi as TxWalletApi } from '@/lib/governance/drepTx.js';
import { verifyHostedAnchor } from '@/lib/governance/anchorSelfVerify.js';
import { drepIdFromKeyHash } from '@/lib/cardano/identity.js';
import { blake2b224 } from '@/lib/crypto/blake.js';
import { hexToBytes } from '@/lib/crypto/hex.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import DrepProfileFields, { type DrepProfileValue, profileLinksToWire } from '@/components/DrepProfileFields.js';
import type { HostedImage } from '@/components/DrepImageUpload.js';
import WalletConnection from '@/components/WalletConnection.js';

// Same enabled-api shape as DRepService: CIP-30 tx surface plus the cip95
// reader for the DRep key and getNetworkId for the network guard.
type EnabledWalletApi = TxWalletApi & {
  getNetworkId(): Promise<number>;
  cip95?: { getPubDRepKey(): Promise<string> };
};

type Phase =
  | { status: 'idle' }
  | { status: 'submitting' }
  // immediate: the optimistic profile write landed, so the new metadata is
  // already visible and the success copy can drop the "after next sync" wait.
  | { status: 'success'; txHash: string; immediate?: boolean }
  | { status: 'error'; message: string };

export interface DrepSettingsProps {
  // Resolved at build time from the .astro shell; defaults to preprod.
  network?: CardanoNetwork;
  /** The session's drep id; the connected wallet must derive the same one. */
  expectedDrepId: string;
  /** Prefill from the synced dreps row; empty strings when no metadata yet. */
  initialName: string;
  initialBio: string;
  initialLinks: { label: string; uri: string }[];
  initialImage: HostedImage | null;
  initialMotivations: string;
  initialQualifications: string;
  initialPaymentAddress: string;
  initialDoNotList: boolean;
}

/** True when the wallet-derived drep id matches the session's. Pure; exported for tests. */
export function identityMatches(walletDrepId: string, expectedDrepId: string): boolean {
  return walletDrepId.toLowerCase() === expectedDrepId.toLowerCase();
}

export default function DrepSettings({
  network = 'preprod',
  expectedDrepId,
  initialName,
  initialBio,
  initialLinks,
  initialImage,
  initialMotivations,
  initialQualifications,
  initialPaymentAddress,
  initialDoNotList,
}: DrepSettingsProps) {
  const { wallets, selected, setSelected } = useCardanoWallets();
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });

  // Caches the enabled CIP-30 api between actions (enable() is idempotent but
  // each call is an extension IPC round trip).
  const enabledApiRef = useRef<EnabledWalletApi | null>(null);

  const [profile, setProfile] = useState<DrepProfileValue>({
    name: initialName,
    bio: initialBio,
    links: initialLinks,
    image: initialImage,
    motivations: initialMotivations,
    qualifications: initialQualifications,
    paymentAddress: initialPaymentAddress,
    doNotList: initialDoNotList,
  });

  // Connects the selected wallet, runs the network guard, derives the DRep
  // identity, and verifies it matches the signed-in DRep. Returns null after
  // setting an error phase when any step fails.
  async function connectAndVerify(): Promise<{ api: EnabledWalletApi; drepKeyHash: Uint8Array } | null> {
    const walletInfo = wallets.find((w) => w.key === selected);
    if (!walletInfo) {
      setPhase({ status: 'error', message: 'Please select a wallet.' });
      return null;
    }

    let api = enabledApiRef.current;
    try {
      if (!api) {
        api = (await walletInfo.raw.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi;
      }
      await assertWalletNetwork(api, network);
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return null;
    }

    if (!api.cip95 || typeof api.cip95.getPubDRepKey !== 'function') {
      setPhase({
        status: 'error',
        message:
          'This wallet does not support CIP-95, which is required to manage a DRep. Please use a DRep-capable wallet (e.g. Lace, Eternl, Typhon).',
      });
      return null;
    }

    enabledApiRef.current = api;

    let drepKeyHash: Uint8Array;
    let drepId: string;
    try {
      const pubKeyHex = await api.cip95.getPubDRepKey();
      drepKeyHash = blake2b224(hexToBytes(pubKeyHex));
      drepId = drepIdFromKeyHash(drepKeyHash);
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return null;
    }

    if (!identityMatches(drepId, expectedDrepId)) {
      setPhase({
        status: 'error',
        message: `This wallet belongs to a different DRep (${drepId}). Please connect the wallet you signed in with.`,
      });
      return null;
    }

    // The right wallet for this DRep: remember it as the future default.
    rememberWallet(selected);

    return { api, drepKeyHash };
  }

  // Update flow: host the new CIP-119 document, then have the wallet sign and
  // submit the update_drep certificate pointing at it.
  async function handleUpdate() {
    const trimmedName = profile.name.trim();
    if (!trimmedName) {
      setPhase({ status: 'error', message: 'Please enter a name for your DRep.' });
      return;
    }

    setPhase({ status: 'submitting' });

    try {
      const connected = await connectAndVerify();
      if (!connected) return;

      const metaRes = await fetchWithTimeout('/api/drep/metadata', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          drepId: expectedDrepId,
          name: trimmedName,
          bio: profile.bio.trim(),
          links: profileLinksToWire(profile.links),
          ...(profile.image ? { image: profile.image } : {}),
          motivations: profile.motivations.trim(),
          qualifications: profile.qualifications.trim(),
          paymentAddress: profile.paymentAddress.trim(),
          doNotList: profile.doNotList,
        }),
      });
      if (!metaRes.ok) {
        const body = (await metaRes.json().catch(() => null)) as { error?: string } | null;
        setPhase({
          status: 'error',
          message: body?.error
            ? `Could not save your DRep profile: ${body.error}.`
            : 'Could not save your DRep profile. Please try again.',
        });
        return;
      }
      const { url, hash } = (await metaRes.json()) as { url: string; hash: string };

      // Before the wallet signs the (irreversible) anchor, confirm the hosted
      // document still hashes to the hash we are about to commit. A mismatch
      // aborts; a transient fetch failure only skips the check.
      if ((await verifyHostedAnchor(url, hash)) === 'mismatch') {
        setPhase({
          status: 'error',
          message: 'The saved profile did not match its hash. Nothing was submitted; please try again.',
        });
        return;
      }

      const { txHash } = await updateDRepMetadata({
        walletApi: connected.api,
        network,
        drepKeyHash: connected.drepKeyHash,
        anchorUrl: url,
        anchorHashHex: hash,
        origin: window.location.origin,
      });

      // Optimistically apply the just-anchored profile to our DB so the change
      // shows now instead of after the next sync. Best effort: a failure here
      // never turns the successful transaction into an error, it only means the
      // success copy keeps the "after next sync" wording.
      const immediate = await fetchWithTimeout('/api/drep/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j as { applied?: boolean } | null)?.applied === true)
        .catch(() => false);

      setPhase({ status: 'success', txHash, immediate });
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
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Profile update submitted</p>
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
              {phase.immediate
                ? 'Your profile on DRepTalk is updated. Wallets and explorers show the change once the transaction confirms.'
                : 'Your profile shows the new metadata after the next sync (within about an hour).'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (wallets.length === 0) {
    return (
      <p style={{ color: 'var(--muted)', maxWidth: '32rem' }}>
        No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
      </p>
    );
  }

  const selectedWalletName = wallets.find((w) => w.key === selected)?.name ?? null;

  return (
    <div style={{ maxWidth: '60rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div style={{ maxWidth: '32rem' }}>
        <WalletConnection wallets={wallets} selected={selected} onSelect={setSelected} disabled={busy} note="This wallet will be used to sign your on-chain metadata update." />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleUpdate();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}
      >
        <DrepProfileFields value={profile} onChange={setProfile} disabled={busy} idPrefix="settings-drep" seed={expectedDrepId} />

        <div className="callout" role="note" style={{ maxWidth: '32rem' }}>
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--muted)' }}>
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.25rem', fontWeight: 600 }}>On-chain update</p>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>
              Updating your metadata is an on-chain transaction. There is no deposit; your wallet pays
              only the small network fee. Your public profile shows the update after the next sync
              (within about an hour).
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', flexWrap: 'wrap' }}>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Awaiting wallet...' : 'Update on-chain'}
          </button>
          {selectedWalletName && (
            <span style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>
              You'll be asked to sign with {selectedWalletName}.
            </span>
          )}
        </div>

        {busy && (
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
            Please review and approve the transaction in your wallet.
          </p>
        )}
      </form>

      {phase.status === 'error' && (
        <div className="callout callout--error" role="alert" style={{ maxWidth: '32rem' }}>
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
    </div>
  );
}
