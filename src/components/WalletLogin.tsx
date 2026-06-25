// React island: Cardano wallet picker and wallet-sign login flow.
// Standard wallet sign-in is the primary path; multisig/script DReps live behind
// an Advanced disclosure. Flow logic lives in loginWithWallet / loginOffline.
import { useState, useEffect, type CSSProperties, type ReactNode } from 'react';
import { loginWithWallet } from '@/lib/auth/walletLogin.js';
import type { WalletApi } from '@/lib/auth/walletLogin.js';
import { requestChallenge, loginOffline } from '@/lib/auth/offlineLogin.js';
import { bytesToHex } from '@/lib/crypto/hex.js';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import WalletConnection from '@/components/WalletConnection.js';
import { networkMismatchMessage, WALLET_NETWORK_MISMATCH } from '@/lib/wallet/networkGuard.js';
import type { CardanoNetwork } from '@/lib/config/network.js';

type LoginState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'awaiting-signature' }
  | { status: 'success'; userId: string; roles: string[] }
  | { status: 'error'; message: string };

type SignMethod = 'wallet' | 'signer';

// Maps the server's terse error codes to a clear, role-aware explanation with a
// next step. Unknown codes fall back to the (capitalized) server message.
function friendlyLoginError(
  error: string | undefined,
  role: 'drep' | 'proposer',
  network: CardanoNetwork,
): string {
  const e = (error ?? '').toLowerCase();
  if (!e) return 'Login failed. Please try again.';
  if (e.includes(WALLET_NETWORK_MISMATCH)) {
    return networkMismatchMessage(network);
  }
  if (e.includes('cip-95')) {
    return 'This wallet does not support CIP-95. Please use a DRep-capable wallet (e.g. Lace, Eternl, Typhon).';
  }
  if (e.includes('nonce')) {
    return 'Your login challenge expired. Please try signing in again.';
  }
  if (e.includes('key-based drep in script flow')) {
    return 'That is a key-based DRep ID, not a script DRep. Use the wallet sign-in above, or, for CLI keys with no browser wallet, the cardano-signer sign-in (no Script DRep ID needed).';
  }
  if (e.includes('plutus script drep unsupported')) {
    return 'This is a Plutus-script DRep, which cannot sign in: there are no keys to prove membership. Only native-script (multisig) DReps are supported here.';
  }
  if (e.includes('not a script drep member')) {
    return 'This key is not one of the script DRep’s authorized signers, or the DRep id is wrong. Check the id and sign with a member key.';
  }
  if (e.includes('signature verification') || e.includes('invalid address in signature')) {
    return 'We could not verify your wallet signature. Please try signing again.';
  }
  if (e.includes('address type mismatch')) {
    return role === 'drep'
      ? 'This wallet did not sign as a DRep. Pick a wallet/account that has a DRep key (CIP-95) and keep the DRep role selected, or register as a DRep first.'
      : 'This wallet did not sign with a reward address. Use the wallet that submitted the governance action and select the Proposer role.';
  }
  if (e.includes('not an active drep')) {
    return 'This wallet is not a registered, active DRep on this network. Register as a DRep to take part.';
  }
  if (e.includes('not a proposer or moderator')) {
    return 'This wallet has not submitted a governance action and is not a listed moderator, so it cannot sign in.';
  }
  if (e.includes('invalid request')) {
    return 'Something was off with the login request. Please try again.';
  }
  if (e.includes('login failed') || e.includes('service unavailable') || e.includes('internal')) {
    return 'Login failed, the service may be busy. Please try again.';
  }
  const msg = error!.charAt(0).toUpperCase() + error!.slice(1);
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

// Two-or-more button toggle that reads as a single control, used for role and
// signing-method choices instead of bare radios. The selected segment is a
// subtle tint, not a solid fill, so it never competes with the primary button.
function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        gap: '0.25rem',
        margin: 0,
        minInlineSize: 0,
        padding: '0.25rem',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm, 9px)',
        background: 'var(--surface)',
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            disabled={disabled}
            aria-pressed={active}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
              padding: '0.5rem 0.75rem',
              borderRadius: '0.45rem',
              border: 'none',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: '0.9375rem',
              fontWeight: active ? 600 : 500,
              fontFamily: 'inherit',
              background: active ? 'color-mix(in srgb, var(--accent) 12%, var(--bg))' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--muted)',
              boxShadow: active ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent)' : 'none',
              transition: 'background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease',
            }}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}

// Person icons for the role segments: a filled mark for DRep, an outline for Proposer.
const drepIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M12 14c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" />
  </svg>
);
const proposerIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20v-1a6 6 0 0 1 12 0v1" />
  </svg>
);

const cardStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius, 14px)',
  background: 'var(--bg)',
  boxShadow: 'var(--shadow)',
  padding: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
};

const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 600,
  color: 'var(--muted)',
  marginBottom: '0.4rem',
};

// Numbered step heading for the primary card sections ("1. Your wallet", etc.).
const stepHeadingStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.9375rem',
  fontWeight: 700,
  color: 'var(--fg)',
  marginBottom: '0.6rem',
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: '0.9375rem',
};

interface WalletLoginProps {
  // Resolved at build time from the .astro shell; defaults to preprod. Drives
  // the CIP-19 type-6 DRep address header (0x60 preprod / 0x61 mainnet).
  network?: CardanoNetwork;
}

export default function WalletLogin({ network = 'preprod' }: WalletLoginProps) {
  const { wallets, selected: selectedWallet, setSelected: setSelectedWallet } = useCardanoWallets();
  const [role, setRole] = useState<'drep' | 'proposer'>('drep');
  const [loginState, setLoginState] = useState<LoginState>({ status: 'idle' });

  // Advanced (multisig / script DRep) state.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [scriptDrepId, setScriptDrepId] = useState('');
  const [keyChoice, setKeyChoice] = useState<'drep' | 'stake'>('drep');
  const [signMethod, setSignMethod] = useState<SignMethod>('wallet');
  const [signerPayload, setSignerPayload] = useState('');
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);

  // Preselect the role from a ?role= deep link (e.g. the header entry menu).
  // Only the roles this flow supports are honored; the server validates the
  // role independently, so this just sets the initial choice.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('role');
    if (r === 'drep' || r === 'proposer') setRole(r);
  }, []);

  // Fetch a challenge whenever the cardano-signer method is active. A login
  // challenge is single-use and expires after a few minutes, so retries refetch
  // via refreshSignerChallenge below.
  useEffect(() => {
    if (!advancedOpen || signMethod !== 'signer') return;
    let active = true;
    setSignerPayload('');
    requestChallenge().then((r) => { if (active && r.ok && r.payload) setSignerPayload(r.payload); });
    return () => { active = false; };
  }, [advancedOpen, signMethod]);

  async function refreshSignerChallenge() {
    setPasted('');
    setSignerPayload('');
    const r = await requestChallenge();
    if (r.ok && r.payload) setSignerPayload(r.payload);
  }

  const busy = loginState.status === 'connecting' || loginState.status === 'awaiting-signature';

  // Wallet sign-in. Standard login passes no multisig; the advanced member path
  // passes { scriptDrepId, keyChoice } and always signs as a DRep.
  async function doWalletLogin(multisig?: { scriptDrepId: string; keyChoice: 'drep' | 'stake' }) {
    const walletInfo = wallets.find((w) => w.key === selectedWallet);
    if (!walletInfo) return;

    setLoginState({ status: 'connecting' });

    const signRole: 'drep' | 'proposer' = multisig ? 'drep' : role;
    let api: WalletApi;
    try {
      const enableOpts =
        walletInfo.supportsCip95 || signRole === 'drep' ? { extensions: [{ cip: 95 }] } : undefined;
      api = await walletInfo.raw.enable(enableOpts);
    } catch {
      setLoginState({ status: 'error', message: 'Wallet connection was rejected.' });
      return;
    }

    setLoginState({ status: 'awaiting-signature' });

    const result = await loginWithWallet(api, signRole, network, multisig ? { multisig } : undefined);

    if (result.ok && result.user) {
      rememberWallet(selectedWallet);
      setLoginState({ status: 'success', userId: result.user.id, roles: result.user.roles });
      // Full page load lets the SSR header pick up the new session cookie.
      window.location.assign('/discussions');
    } else {
      setLoginState({ status: 'error', message: friendlyLoginError(result.error, signRole, network) });
    }
  }

  // Offline (cardano-signer) member sign-in for a script DRep.
  async function doPasteLogin() {
    setLoginState({ status: 'awaiting-signature' });
    const r = await loginOffline({ role: 'drep', payload: signerPayload, pastedText: pasted, scriptDrepId: scriptDrepId.trim() });
    if (r.ok && r.user) {
      window.location.assign('/discussions');
    } else {
      setLoginState({ status: 'error', message: friendlyLoginError(r.error, 'drep', network) });
      // This attempt consumed the challenge; load a fresh one so the user can
      // re-sign without reloading the page.
      void refreshSignerChallenge();
    }
  }

  function reset() {
    setLoginState({ status: 'idle' });
    // In the paste flow the shown challenge is now stale or consumed; pull a
    // fresh one so the next signed command is not rejected as expired.
    if (advancedOpen && signMethod === 'signer') void refreshSignerChallenge();
  }

  // Hex (--data-hex), not plain --data: some cardano-signer versions treat --data
  // as hex and reject text. Same signed bytes, so server verification is unchanged.
  const command = signerPayload
    ? `cardano-signer sign --data-hex "${bytesToHex(new TextEncoder().encode(signerPayload))}" --secret-key drep.skey --json`
    : '';
  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context); the command stays selectable.
    }
  }

  // Status / error region, shown in whichever section is active.
  function statusBlock() {
    if (loginState.status === 'connecting') {
      return <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>Connecting to wallet...</p>;
    }
    if (loginState.status === 'awaiting-signature') {
      const msg =
        advancedOpen && signMethod === 'signer'
          ? 'Verifying your signature...'
          : 'Please sign the login challenge in your wallet.';
      return <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>{msg}</p>;
    }
    if (loginState.status === 'error') {
      return (
        <div className="callout callout--error" role="alert">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div className="callout__body">
            {loginState.message}
            <div style={{ marginTop: '0.6rem' }}>
              <button
                type="button"
                onClick={reset}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}
              >
                Try again
              </button>
              <span style={{ color: 'var(--muted)', margin: '0 0.5rem' }}>or</span>
              <a href="/register-drep" style={{ color: 'var(--accent)' }}>register as a DRep</a>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  if (loginState.status === 'success') {
    return (
      <div style={cardStyle}>
        <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>Logged in</p>
        <p style={{ margin: '0 0 0.25rem', fontSize: '0.875rem', color: 'var(--muted)' }}>User: {loginState.userId}</p>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>Roles: {loginState.roles.join(', ')}</p>
      </div>
    );
  }

  if (wallets.length === 0) {
    return (
      <div style={cardStyle}>
        <p style={{ color: 'var(--muted)', margin: 0 }}>
          No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
        </p>
      </div>
    );
  }

  const pasteDisabled = busy || !signerPayload || !scriptDrepId.trim();
  const memberWalletDisabled = busy || !scriptDrepId.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Primary card: standard wallet sign-in */}
      <div style={cardStyle}>
        <div>
          <span style={stepHeadingStyle}>1. Your wallet</span>
          <WalletConnection
            wallets={wallets}
            selected={selectedWallet}
            onSelect={setSelectedWallet}
            disabled={busy}
            label=""
          />
        </div>

        <div>
          <span style={stepHeadingStyle}>2. Sign in as</span>
          <SegmentedControl
            ariaLabel="Sign in as"
            value={role}
            onChange={setRole}
            disabled={busy}
            options={[
              { value: 'drep', label: 'DRep', icon: drepIcon },
              { value: 'proposer', label: 'Proposer', icon: proposerIcon },
            ]}
          />
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => doWalletLogin()}
          disabled={busy}
          style={{ width: '100%', padding: '0.65rem 1rem', fontSize: '0.9375rem', opacity: busy ? 0.7 : 1 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" />
          </svg>
          {busy ? 'Signing in...' : 'Sign in with wallet'}
        </button>

        <p style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', margin: 0, fontSize: '0.8125rem', color: 'var(--muted)' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" />
          </svg>
          You will sign a one-time message. This does not submit a transaction or cost fees.
        </p>

        {!advancedOpen && statusBlock()}
      </div>

      {/* Advanced disclosure: multisig / script DRep */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius, 14px)', background: 'var(--bg)', overflow: 'hidden' }}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%', padding: '0.9rem 1.1rem', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--fg)', fontFamily: 'inherit' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontWeight: 600, fontSize: '0.9375rem', color: 'var(--accent)' }}>Advanced options</span>
            <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--muted)', marginTop: '0.1rem' }}>For multisig / native-script DRep sign-in</span>
          </span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: 'var(--muted)', transform: advancedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {advancedOpen && (
          <div style={{ borderTop: '1px solid var(--border)', background: 'var(--surface)', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)', lineHeight: 1.55 }}>
              Use this if your DRep credential is controlled by a native script or multisig setup. Prove membership by signing as one of its authorized keys.
            </p>

            <div>
              <label htmlFor="script-drep-id" style={fieldLabelStyle}>Script DRep ID</label>
              <input
                id="script-drep-id"
                type="text"
                value={scriptDrepId}
                onChange={(e) => setScriptDrepId(e.target.value)}
                placeholder="drep1..."
                disabled={busy}
                style={inputStyle}
              />
            </div>

            <div>
              <span style={fieldLabelStyle}>Signing method</span>
              <SegmentedControl
                ariaLabel="Signing method"
                value={signMethod}
                onChange={setSignMethod}
                disabled={busy}
                options={[
                  { value: 'wallet', label: 'Connected wallet' },
                  { value: 'signer', label: 'cardano-signer' },
                ]}
              />
            </div>

            {signMethod === 'wallet' ? (
              <>
                <div>
                  <label htmlFor="member-key" style={fieldLabelStyle}>Sign with</label>
                  <select
                    id="member-key"
                    value={keyChoice}
                    onChange={(e) => setKeyChoice(e.target.value as 'drep' | 'stake')}
                    disabled={busy}
                    style={inputStyle}
                  >
                    <option value="drep">DRep key</option>
                    <option value="stake">Stake key</option>
                  </select>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => doWalletLogin({ scriptDrepId: scriptDrepId.trim(), keyChoice })}
                  disabled={memberWalletDisabled}
                  style={{ width: '100%', padding: '0.8rem 1.25rem', fontSize: '1rem', opacity: memberWalletDisabled ? 0.6 : 1, cursor: memberWalletDisabled ? 'not-allowed' : 'pointer' }}
                >
                  {busy ? 'Signing in...' : 'Sign in as script DRep'}
                </button>
              </>
            ) : (
              <>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.4rem' }}>
                    <span style={{ ...fieldLabelStyle, marginBottom: 0 }}>Signing challenge</span>
                    <button
                      type="button"
                      onClick={copyCommand}
                      disabled={!signerPayload}
                      className="btn btn-secondary"
                      style={{ padding: '0.3rem 0.6rem', fontSize: '0.8125rem' }}
                    >
                      {copied ? 'Copied' : 'Copy command'}
                    </button>
                  </div>
                  <p style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem', color: 'var(--muted)' }}>
                    Run this command locally with your member signing key, then paste the JSON output below.
                  </p>
                  <code style={{ display: 'block', fontSize: '0.75rem', wordBreak: 'break-all', background: 'var(--bg)', border: '1px solid var(--border)', padding: '0.6rem', borderRadius: '0.5rem' }}>
                    {signerPayload ? command : 'Loading challenge...'}
                  </code>
                </div>

                <div>
                  <label htmlFor="signer-output" style={fieldLabelStyle}>Paste cardano-signer JSON output</label>
                  <textarea
                    id="signer-output"
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    placeholder="Paste the JSON output here..."
                    rows={4}
                    disabled={busy}
                    style={{ ...inputStyle, fontFamily: 'monospace', fontSize: '0.8125rem', resize: 'vertical' }}
                  />
                </div>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={doPasteLogin}
                  disabled={pasteDisabled}
                  style={{ width: '100%', padding: '0.8rem 1.25rem', fontSize: '1rem', opacity: pasteDisabled ? 0.6 : 1, cursor: pasteDisabled ? 'not-allowed' : 'pointer' }}
                >
                  {busy ? 'Verifying...' : 'Sign in with pasted signature'}
                </button>
              </>
            )}

            {statusBlock()}
          </div>
        )}
      </div>
    </div>
  );
}
