// React island: settings panel for a signed-in DRep.
//
// Inverse of DRepService: assumes an already-registered DRep (the session's
// drep id arrives as expectedDrepId) and offers two non-custodial actions:
// update the CIP-119 metadata anchor (update_drep, no deposit) and retire
// (unreg_drep, deposit refund). The wallet signs and submits; the server only
// hosts the metadata document and proxies Koios.
import { useState, useRef } from 'react';
import { useCardanoWallets } from '@/lib/wallet/useCardanoWallets.js';
import { updateDRepMetadata, retireDRep } from '@/lib/governance/drepTx.js';
import type { WalletApi as TxWalletApi } from '@/lib/governance/drepTx.js';
import { drepIdFromKeyHash } from '@/lib/cardano/identity.js';
import { blake2b224 } from '@/lib/crypto/blake.js';
import { hexToBytes } from '@/lib/crypto/hex.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import { parseLinks } from '@/components/DRepService.js';
import DrepImageUpload, { type HostedImage } from '@/components/DrepImageUpload.js';

// Same enabled-api shape as DRepService: CIP-30 tx surface plus the cip95
// reader for the DRep key and getNetworkId for the network guard.
type EnabledWalletApi = TxWalletApi & {
  getNetworkId(): Promise<number>;
  cip95?: { getPubDRepKey(): Promise<string> };
};

const NAME_MAX = 80;
const BIO_MAX = 1500;

type DrepAction = 'update' | 'retire';

type Phase =
  | { status: 'idle' }
  | { status: 'submitting'; action: DrepAction }
  | { status: 'success'; txHash: string; action: DrepAction }
  | { status: 'error'; message: string };

export interface DrepSettingsProps {
  // Resolved at build time from the .astro shell; defaults to preprod.
  network?: CardanoNetwork;
  /** The session's drep id; the connected wallet must derive the same one. */
  expectedDrepId: string;
  /** Prefill from the synced dreps row; empty strings when no metadata yet. */
  initialName: string;
  initialBio: string;
  /** One URL per line, pre-joined by the page. */
  initialLinks: string;
  initialImage: HostedImage | null;
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
}: DrepSettingsProps) {
  const { wallets, selected, setSelected } = useCardanoWallets();
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });

  // Caches the enabled CIP-30 api between actions (enable() is idempotent but
  // each call is an extension IPC round trip).
  const enabledApiRef = useRef<EnabledWalletApi | null>(null);

  const [name, setName] = useState(initialName);
  const [bio, setBio] = useState(initialBio);
  const [links, setLinks] = useState(initialLinks);
  const [image, setImage] = useState<HostedImage | null>(initialImage);
  const [confirmRetire, setConfirmRetire] = useState(false);

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

    return { api, drepKeyHash };
  }

  // Update flow: host the new CIP-119 document, then have the wallet sign and
  // submit the update_drep certificate pointing at it.
  async function handleUpdate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setPhase({ status: 'error', message: 'Please enter a name for your DRep.' });
      return;
    }

    setPhase({ status: 'submitting', action: 'update' });

    try {
      const connected = await connectAndVerify();
      if (!connected) return;

      const metaRes = await fetch('/api/drep/metadata', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          drepId: expectedDrepId,
          name: trimmedName,
          bio: bio.trim(),
          links: parseLinks(links),
          ...(image ? { image } : {}),
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

      const { txHash } = await updateDRepMetadata({
        walletApi: connected.api,
        network,
        drepKeyHash: connected.drepKeyHash,
        anchorUrl: url,
        anchorHashHex: hash,
        origin: window.location.origin,
      });

      setPhase({ status: 'success', txHash, action: 'update' });
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
    }
  }

  // Retire flow: unreg_drep certificate; checkbox-gated, wallet is the final
  // confirmation. No metadata involved.
  async function handleRetire() {
    setPhase({ status: 'submitting', action: 'retire' });

    try {
      const connected = await connectAndVerify();
      if (!connected) return;

      const { txHash } = await retireDRep({
        walletApi: connected.api,
        network,
        drepKeyHash: connected.drepKeyHash,
        origin: window.location.origin,
      });

      setPhase({ status: 'success', txHash, action: 'retire' });
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
    }
  }

  const busy = phase.status === 'submitting';

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.5rem 0.75rem',
    border: '1px solid var(--border)',
    borderRadius: '0.375rem',
    background: 'var(--bg)',
    color: 'var(--fg)',
    fontSize: '1rem',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.875rem',
    marginBottom: '0.25rem',
    color: 'var(--muted)',
  };

  if (phase.status === 'success') {
    return (
      <div style={{ maxWidth: '32rem' }}>
        <div className="callout callout--success" role="status">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>
              {phase.action === 'retire' ? 'Retirement submitted' : 'Profile update submitted'}
            </p>
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
              {phase.action === 'retire'
                ? 'Your DRep deposit is refunded once the transaction is confirmed. Your forum account and posts are unaffected.'
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

  return (
    <div style={{ maxWidth: '32rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>Wallet</span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={busy}
          style={{ ...inputStyle, padding: '0.5rem' }}
        >
          {wallets.map((w) => (
            <option key={w.key} value={w.key}>
              {w.name}
              {w.supportsCip95 ? ' (CIP-95)' : ''}
            </option>
          ))}
        </select>
      </label>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleUpdate();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}
      >
        <div>
          <label htmlFor="settings-drep-name" style={labelStyle}>
            Name
          </label>
          <input
            id="settings-drep-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your DRep name"
            maxLength={NAME_MAX}
            required
            disabled={busy}
            style={inputStyle}
          />
        </div>

        <div>
          <span style={labelStyle}>Profile image (optional)</span>
          <DrepImageUpload value={image} onChange={setImage} disabled={busy} />
        </div>

        <div>
          <label htmlFor="settings-drep-bio" style={labelStyle}>
            Bio
          </label>
          <textarea
            id="settings-drep-bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Tell delegators what you stand for (plain text)."
            maxLength={BIO_MAX}
            rows={6}
            disabled={busy}
            style={{ ...inputStyle, lineHeight: '1.6', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        <div>
          <label htmlFor="settings-drep-links" style={labelStyle}>
            Links
          </label>
          <textarea
            id="settings-drep-links"
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            placeholder="One URL per line (or comma separated). Website, X, GitHub, etc."
            rows={3}
            disabled={busy}
            style={{ ...inputStyle, lineHeight: '1.6', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </div>

        <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)' }}>
          Updating your metadata is an on-chain transaction. There is no deposit;
          your wallet pays only the small network fee. Your public profile shows
          the update after the next sync (within about an hour).
        </p>

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
            {phase.status === 'submitting' && phase.action === 'update' ? 'Awaiting wallet...' : 'Update on-chain'}
          </button>
        </div>

        {phase.status === 'submitting' && phase.action === 'update' && (
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
            Please review and approve the transaction in your wallet.
          </p>
        )}
      </form>

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

      <section style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Retire as DRep</h3>

        <div className="callout callout--error" role="note">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>This is an on-chain action</p>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem' }}>
              Retiring submits a deregistration certificate to the Cardano chain. Your
              500 ADA deposit is refunded once it confirms, and everyone who delegated
              their voting power to you loses that delegation. You can register again
              later.
            </p>
            <p style={{ margin: 0, fontSize: '0.875rem' }}>
              This does <strong>not</strong> delete anything on DRepTalk: your forum
              account, posts, and profile page remain.
            </p>
          </div>
        </div>

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
              color: '#dc2626',
              border: '1px solid #dc2626',
              borderRadius: '0.375rem',
              fontSize: '0.9375rem',
              fontWeight: 500,
              cursor: busy || !confirmRetire ? 'not-allowed' : 'pointer',
              opacity: busy || !confirmRetire ? 0.6 : 1,
            }}
          >
            {phase.status === 'submitting' && phase.action === 'retire' ? 'Awaiting wallet...' : 'Retire DRep'}
          </button>
        </div>

        {phase.status === 'submitting' && phase.action === 'retire' && (
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
            Please review and approve the deregistration in your wallet.
          </p>
        )}
      </section>
    </div>
  );
}
