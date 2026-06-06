// React island: client-side, non-custodial DRep registration flow.
//
// Mirrors WalletLogin for wallet enumeration, CIP-95 enabling, and the
// callout-based status rendering. The server never sees a private key: the
// wallet builds nothing, but it does sign and submit the reg_drep transaction
// (see registerDRep). The only server calls here are reading public chain data
// via the Koios proxy and hosting the metadata document.
import { useState } from 'react';
import { useCardanoWallets } from '@/lib/wallet/useCardanoWallets.js';
import { registerDRep } from '@/lib/governance/drepTx.js';
import type { WalletApi as TxWalletApi } from '@/lib/governance/drepTx.js';
import { drepIdFromPubKey } from '@/lib/cardano/identity.js';
import { blake2b224 } from '@/lib/crypto/blake.js';
import { hexToBytes } from '@/lib/crypto/hex.js';

// The enabled wallet api is the CIP-30 surface plus the optional CIP-95
// extension namespace. We intersect the structural Tx api (used by
// registerDRep) with the cip95 reader we need to derive the DRep key.
type EnabledWalletApi = TxWalletApi & {
  cip95?: { getPubDRepKey(): Promise<string> };
};

type Network = 'preprod' | 'mainnet';

// A few sensible, light client-side limits. The /api/drep/metadata endpoint is
// the real validator; this only keeps obvious mistakes out of the wallet prompt.
const NAME_MAX = 80;
const BIO_MAX = 1500;

interface DRepIdentity {
  drepId: string;
  drepKeyHash: Uint8Array;
}

type Phase =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'checking'; identity: DRepIdentity }
  | { status: 'already-registered'; identity: DRepIdentity }
  | { status: 'form'; identity: DRepIdentity }
  | { status: 'submitting'; identity: DRepIdentity }
  | { status: 'success'; txHash: string }
  | { status: 'error'; message: string };

interface DRepServiceProps {
  // Resolved at build time from the .astro shell; defaults to preprod.
  network?: Network;
}

// Splits the free-form links field (newline or comma separated) into a clean
// list of trimmed, non-empty entries. Exported for unit testing.
export function parseLinks(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Maps wallet/network failures to a readable sentence. CIP-30 errors carry
// { code, info }; prefer info, then message, then a generic fallback.
function readableError(err: unknown): string {
  const e = err as { info?: unknown; message?: unknown } | null;
  const detail =
    (typeof e?.info === 'string' && e.info) ||
    (typeof e?.message === 'string' && e.message) ||
    '';
  if (!detail) return 'Something went wrong. Please try again.';
  const msg = detail.charAt(0).toUpperCase() + detail.slice(1);
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}

export default function DRepService({ network = 'preprod' }: DRepServiceProps) {
  const { wallets, selected, setSelected } = useCardanoWallets();
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });

  // Registration form fields.
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [links, setLinks] = useState('');

  const explorerBase =
    network === 'mainnet'
      ? 'https://cardanoscan.io/transaction/'
      : 'https://preprod.cardanoscan.io/transaction/';

  // Step 1 + 2 + 3: connect, derive the DRep identity, check current status.
  async function handleConnect() {
    const walletInfo = wallets.find((w) => w.key === selected);
    if (!walletInfo) return;

    setPhase({ status: 'connecting' });

    // Enable with the CIP-95 extension (required to read the DRep key).
    // The hook types enable() as the narrow login WalletApi; at runtime it is
    // the full CIP-30 object, so we view it through our richer shape via unknown.
    let api: EnabledWalletApi;
    try {
      api = (await walletInfo.raw.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi;
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return;
    }

    // CIP-95 must be present to derive the DRep key. Some wallets accept the
    // enable call but do not expose the cip95 namespace.
    if (!api.cip95 || typeof api.cip95.getPubDRepKey !== 'function') {
      setPhase({
        status: 'error',
        message:
          'This wallet does not support CIP-95, which is required to register as a DRep. Please use a DRep-capable wallet (e.g. Lace, Eternl, Typhon).',
      });
      return;
    }

    // Derive the DRep key hash (28-byte blake2b-224) and the CIP-129 drep1 id.
    let identity: DRepIdentity;
    try {
      const pubKeyHex = await api.cip95.getPubDRepKey();
      const pubKeyBytes = hexToBytes(pubKeyHex);
      identity = {
        drepKeyHash: blake2b224(pubKeyBytes),
        drepId: drepIdFromPubKey(pubKeyBytes),
      };
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
      return;
    }

    setPhase({ status: 'checking', identity });

    // Check current on-chain status via the Koios proxy. A registered, active
    // DRep should not be offered registration again (retire is a later phase).
    try {
      const res = await fetch('/api/koios/drep_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _drep_ids: [identity.drepId] }),
      });
      if (res.ok) {
        const rows = (await res.json()) as Array<{
          drep_status?: string;
          active?: boolean;
        }>;
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (row && row.active === true && row.drep_status === 'registered') {
          setPhase({ status: 'already-registered', identity });
          return;
        }
      }
      // Any non-ok response or "not registered" row falls through to the form.
      // The submit step is the authoritative gate; a stale read just shows it.
    } catch {
      // A failed status read should not block registration. Show the form and
      // let the wallet + chain be the final authority at submit time.
    }

    setPhase({ status: 'form', identity });
  }

  // Step 4: build the metadata, then have the wallet sign and submit reg_drep.
  async function handleRegister(identity: DRepIdentity) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setPhase({ status: 'error', message: 'Please enter a name for your DRep.' });
      return;
    }

    setPhase({ status: 'submitting', identity });

    try {
      // 4a: host the CIP-119 metadata, get its URL + hash.
      const metaRes = await fetch('/api/drep/metadata', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          drepId: identity.drepId,
          name: trimmedName,
          bio: bio.trim(),
          links: parseLinks(links),
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

      // 4b + 4c: the wallet builds, signs (deposit + fee shown here), submits.
      const walletInfo = wallets.find((w) => w.key === selected);
      if (!walletInfo) {
        setPhase({ status: 'error', message: 'Wallet connection was lost. Please reconnect.' });
        return;
      }
      const api = (await walletInfo.raw.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi;

      const { txHash } = await registerDRep({
        walletApi: api,
        network,
        drepKeyHash: identity.drepKeyHash,
        anchorUrl: url,
        anchorHashHex: hash,
        origin: window.location.origin,
      });

      setPhase({ status: 'success', txHash });
    } catch (err) {
      setPhase({ status: 'error', message: readableError(err) });
    }
  }

  function reset() {
    setPhase({ status: 'idle' });
  }

  const busy =
    phase.status === 'connecting' ||
    phase.status === 'checking' ||
    phase.status === 'submitting';

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

  // Success state: standalone confirmation, no form.
  if (phase.status === 'success') {
    return (
      <div style={{ maxWidth: '32rem' }}>
        <div className="callout callout--success" role="status">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Registration submitted</p>
            <p style={{ margin: '0 0 0.5rem' }}>
              Transaction:{' '}
              <a href={`${explorerBase}${phase.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                {phase.txHash}
              </a>
            </p>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
              Your DRep becomes active once the transaction is confirmed.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '32rem' }}>
      {/* Note shown before the wallet prompt: this DOES cost a deposit + fee. */}
      <p style={{ fontSize: '0.875rem', color: 'var(--muted)', margin: '0 0 1.25rem' }}>
        Registering as a DRep is an on-chain transaction. Your wallet will ask you to
        approve a refundable deposit plus a small network fee. dreptalk.com never sees
        your keys; your wallet signs and submits everything.
      </p>

      {wallets.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>
          No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          {/* Wallet picker (hidden once the form/registered state is reached). */}
          {(phase.status === 'idle' ||
            phase.status === 'connecting' ||
            phase.status === 'error') && (
            <>
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
              <button
                onClick={handleConnect}
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
                {phase.status === 'connecting' ? 'Connecting...' : 'Connect wallet'}
              </button>
            </>
          )}

          {phase.status === 'checking' && (
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
              Checking your DRep status...
            </p>
          )}

          {phase.status === 'already-registered' && (
            <div className="callout callout--info" role="status">
              <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <div className="callout__body">
                <p style={{ margin: '0 0 0.25rem', fontWeight: 600 }}>You are already a registered DRep</p>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                  DRep id: {phase.identity.drepId}
                </p>
              </div>
            </div>
          )}

          {/* Registration form. */}
          {(phase.status === 'form' || phase.status === 'submitting') && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleRegister(phase.identity);
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}
            >
              <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)' }}>
                DRep id: {phase.identity.drepId}
              </p>

              <div>
                <label htmlFor="drep-name" style={labelStyle}>
                  Name
                </label>
                <input
                  id="drep-name"
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
                <label htmlFor="drep-bio" style={labelStyle}>
                  Bio
                </label>
                <textarea
                  id="drep-bio"
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
                <label htmlFor="drep-links" style={labelStyle}>
                  Links
                </label>
                <textarea
                  id="drep-links"
                  value={links}
                  onChange={(e) => setLinks(e.target.value)}
                  placeholder="One URL per line (or comma separated). Website, X, GitHub, etc."
                  rows={3}
                  disabled={busy}
                  style={{ ...inputStyle, lineHeight: '1.6', resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>

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
                  {phase.status === 'submitting' ? 'Awaiting wallet...' : 'Register as DRep'}
                </button>
              </div>

              {phase.status === 'submitting' && (
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                  Please review and approve the transaction in your wallet.
                </p>
              )}
            </form>
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
                  onClick={reset}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}
                >
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
