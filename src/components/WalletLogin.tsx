// React island: Cardano wallet picker and wallet-sign login flow.
// Uses loginWithWallet for the testable flow logic.
import { useState, useEffect } from 'react';
import { loginWithWallet } from '@/lib/auth/walletLogin.js';
import type { WalletApi } from '@/lib/auth/walletLogin.js';
import { requestChallenge, loginOffline } from '@/lib/auth/offlineLogin.js';
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

interface WalletLoginProps {
  // Resolved at build time from the .astro shell; defaults to preprod. Drives
  // the CIP-19 type-6 DRep address header (0x60 preprod / 0x61 mainnet).
  network?: CardanoNetwork;
}

export default function WalletLogin({ network = 'preprod' }: WalletLoginProps) {
  const { wallets, selected: selectedWallet, setSelected: setSelectedWallet } = useCardanoWallets();
  const [role, setRole] = useState<'drep' | 'proposer'>('drep');
  const [multiSig, setMultiSig] = useState(false);
  const [scriptDrepId, setScriptDrepId] = useState('');
  const [keyChoice, setKeyChoice] = useState<'drep' | 'stake'>('drep');
  const [useSigner, setUseSigner] = useState(false);
  const [signerPayload, setSignerPayload] = useState('');
  const [pasted, setPasted] = useState('');
  const [loginState, setLoginState] = useState<LoginState>({ status: 'idle' });

  // Preselect the role from a ?role= deep link (e.g. the header entry menu).
  // Only the roles this flow supports are honored; the server validates the
  // role independently, so this just sets the initial radio choice.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('role');
    if (r === 'drep' || r === 'proposer') setRole(r);
  }, []);

  // Request a fresh challenge when the CardanoSigner paste panel opens.
  useEffect(() => {
    if (!multiSig || !useSigner) return;
    let active = true;
    requestChallenge().then((r) => { if (active && r.ok && r.payload) setSignerPayload(r.payload); });
    return () => { active = false; };
  }, [multiSig, useSigner]);

  async function handleLogin() {
    const walletInfo = wallets.find((w) => w.key === selectedWallet);
    if (!walletInfo) return;

    setLoginState({ status: 'connecting' });

    let api: WalletApi;
    try {
      // Request CIP-95 extension when the wallet reports support.
      const enableOpts =
        walletInfo.supportsCip95 || role === 'drep'
          ? { extensions: [{ cip: 95 }] }
          : undefined;
      api = await walletInfo.raw.enable(enableOpts);
    } catch {
      setLoginState({ status: 'error', message: 'Wallet connection was rejected.' });
      return;
    }

    setLoginState({ status: 'awaiting-signature' });

    const result = await loginWithWallet(
      api,
      // MultiSig script membership is always a DRep login; preserve the chosen role otherwise.
      multiSig ? 'drep' : role,
      network,
      multiSig && scriptDrepId.trim()
        ? { multisig: { scriptDrepId: scriptDrepId.trim(), keyChoice } }
        : undefined,
    );

    if (result.ok && result.user) {
      // Remember the wallet so registration and settings preselect it later.
      rememberWallet(selectedWallet);
      setLoginState({ status: 'success', userId: result.user.id, roles: result.user.roles });
      // Navigate to the discussions feed; the full page load lets the SSR header
      // pick up the new session cookie and render the signed-in state.
      window.location.assign('/discussions');
    } else {
      setLoginState({ status: 'error', message: friendlyLoginError(result.error, role, network) });
    }
  }

  function reset() {
    setLoginState({ status: 'idle' });
  }

  const busy =
    loginState.status === 'connecting' || loginState.status === 'awaiting-signature';

  return (
    <div style={{ maxWidth: '28rem' }}>
      {/* Note shown to user before signing */}
      <p style={{ fontSize: '0.875rem', color: 'var(--muted)', margin: '0 0 1.25rem' }}>
        You are signing a one-time login challenge for dreptalk.com (no transaction, no fees).
      </p>

      {loginState.status === 'success' ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '1rem' }}>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>Logged in</p>
          <p style={{ margin: '0 0 0.25rem', fontSize: '0.875rem', color: 'var(--muted)' }}>
            User: {loginState.userId}
          </p>
          <p style={{ margin: '0', fontSize: '0.875rem', color: 'var(--muted)' }}>
            Roles: {loginState.roles.join(', ')}
          </p>
        </div>
      ) : (
        wallets.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>
            No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {/* Wallet picker (compact; reveals the full list via Change wallet) */}
            <WalletConnection
              wallets={wallets}
              selected={selectedWallet}
              onSelect={setSelectedWallet}
              disabled={busy}
              label="Signing wallet"
            />

            {/* Role toggle */}
            <fieldset
              style={{
                border: '1px solid var(--border)',
                borderRadius: '0.375rem',
                padding: '0.5rem 0.75rem',
                margin: 0,
              }}
            >
              <legend style={{ fontSize: '0.875rem', fontWeight: 500, padding: '0 0.25rem' }}>
                Role
              </legend>
              <div style={{ display: 'flex', gap: '1.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="role"
                    value="drep"
                    checked={role === 'drep'}
                    onChange={() => setRole('drep')}
                    disabled={busy}
                  />
                  DRep
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="role"
                    value="proposer"
                    checked={role === 'proposer'}
                    onChange={() => setRole('proposer')}
                    disabled={busy}
                  />
                  Proposer
                </label>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={multiSig}
                  onChange={(e) => { setMultiSig(e.target.checked); if (e.target.checked) setRole('drep'); }}
                  disabled={busy}
                />
                MultiSig / Script DRep
              </label>
              {multiSig && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <input
                    type="text"
                    value={scriptDrepId}
                    onChange={(e) => setScriptDrepId(e.target.value)}
                    placeholder="Script DRep ID (drep1...)"
                    disabled={busy}
                    style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '0.375rem' }}
                  />
                  <label style={{ fontSize: '0.875rem', color: 'var(--muted)' }}>
                    Sign with:{' '}
                    <select value={keyChoice} onChange={(e) => setKeyChoice(e.target.value as 'drep' | 'stake')} disabled={busy}>
                      <option value="drep">DRep key</option>
                      <option value="stake">Stake key</option>
                    </select>
                  </label>
                  {/* Sub-toggle: wallet sign vs. CardanoSigner paste */}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={useSigner}
                      onChange={(e) => { setUseSigner(e.target.checked); setPasted(''); setSignerPayload(''); }}
                      disabled={busy}
                    />
                    Paste CardanoSigner output
                  </label>
                </div>
              )}
            </fieldset>

            {/* CardanoSigner paste panel: shown only when MultiSig + useSigner are both active */}
            {multiSig && useSigner && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)' }}>
                  Run this command with your member key, then paste the JSON output below:
                </p>
                <code style={{ fontSize: '0.75rem', wordBreak: 'break-all', background: 'var(--surface-alt, var(--border))', padding: '0.5rem', borderRadius: '0.25rem', display: 'block' }}>
                  {signerPayload
                    ? `cardano-signer sign --data "${signerPayload}" --secret-key drep.skey --json`
                    : 'Loading challenge...'}
                </code>
                <textarea
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder="Paste the cardano-signer JSON output"
                  rows={4}
                  disabled={busy}
                  style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '0.375rem', fontFamily: 'monospace', fontSize: '0.8125rem', resize: 'vertical' }}
                />
                <button
                  type="button"
                  disabled={busy || !signerPayload || !scriptDrepId.trim()}
                  onClick={async () => {
                    setLoginState({ status: 'awaiting-signature' });
                    const r = await loginOffline({ role: 'drep', payload: signerPayload, pastedText: pasted, scriptDrepId: scriptDrepId.trim() });
                    if (r.ok && r.user) { window.location.assign('/discussions'); }
                    else setLoginState({ status: 'error', message: friendlyLoginError(r.error, 'drep', network) });
                  }}
                  style={{
                    padding: '0.625rem 1.25rem',
                    background: 'var(--accent)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '0.375rem',
                    fontSize: '1rem',
                    fontWeight: 500,
                    cursor: busy || !signerPayload || !scriptDrepId.trim() ? 'not-allowed' : 'pointer',
                    opacity: busy || !signerPayload || !scriptDrepId.trim() ? 0.7 : 1,
                    alignSelf: 'flex-start',
                  }}
                >
                  {busy ? 'Verifying...' : 'Sign in with pasted signature'}
                </button>
              </div>
            )}

            {/* Status message */}
            {loginState.status === 'connecting' && (
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                Connecting to wallet...
              </p>
            )}
            {loginState.status === 'awaiting-signature' && (
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                Please sign the login challenge in your wallet.
              </p>
            )}
            {loginState.status === 'error' && (
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
                    {role === 'drep' && (
                      <>
                        <span style={{ color: 'var(--muted)', margin: '0 0.5rem' }}>or</span>
                        <a href="/register-drep" style={{ color: 'var(--accent)' }}>register as a DRep</a>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Connect button: hidden when the CardanoSigner paste panel is active */}
            {!(multiSig && useSigner) && <button
              type="button"
              onClick={handleLogin}
              disabled={busy || (multiSig && !scriptDrepId.trim())}
              style={{
                padding: '0.625rem 1.25rem',
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: '0.375rem',
                fontSize: '1rem',
                fontWeight: 500,
                cursor: busy || (multiSig && !scriptDrepId.trim()) ? 'not-allowed' : 'pointer',
                opacity: busy || (multiSig && !scriptDrepId.trim()) ? 0.7 : 1,
                alignSelf: 'flex-start',
              }}
            >
              {busy ? 'Connecting...' : 'Connect and sign in'}
            </button>}
          </div>
        )
      )}
    </div>
  );
}
