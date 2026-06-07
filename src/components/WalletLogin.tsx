// React island: Cardano wallet picker and wallet-sign login flow.
// Uses loginWithWallet for the testable flow logic.
import { useState, useEffect } from 'react';
import { loginWithWallet } from '@/lib/auth/walletLogin.js';
import type { WalletApi } from '@/lib/auth/walletLogin.js';
import { useCardanoWallets } from '@/lib/wallet/useCardanoWallets.js';

type LoginState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'awaiting-signature' }
  | { status: 'success'; userId: string; roles: string[] }
  | { status: 'error'; message: string };

// Maps the server's terse error codes to a clear, role-aware explanation with a
// next step. Unknown codes fall back to the (capitalized) server message.
function friendlyLoginError(error: string | undefined, role: 'drep' | 'proposer'): string {
  const e = (error ?? '').toLowerCase();
  if (!e) return 'Login failed. Please try again.';
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

export default function WalletLogin() {
  const { wallets, selected: selectedWallet, setSelected: setSelectedWallet } = useCardanoWallets();
  const [role, setRole] = useState<'drep' | 'proposer'>('drep');
  const [loginState, setLoginState] = useState<LoginState>({ status: 'idle' });

  // Preselect the role from a ?role= deep link (e.g. the header entry menu).
  // Only the roles this flow supports are honored; the server validates the
  // role independently, so this just sets the initial radio choice.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('role');
    if (r === 'drep' || r === 'proposer') setRole(r);
  }, []);

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

    const result = await loginWithWallet(api, role);

    if (result.ok && result.user) {
      setLoginState({ status: 'success', userId: result.user.id, roles: result.user.roles });
    } else {
      setLoginState({ status: 'error', message: friendlyLoginError(result.error, role) });
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
        <>
          {wallets.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>
              No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {/* Wallet picker */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>Wallet</span>
                <select
                  value={selectedWallet}
                  onChange={(e) => setSelectedWallet(e.target.value)}
                  disabled={busy}
                  style={{
                    padding: '0.5rem',
                    border: '1px solid var(--border)',
                    borderRadius: '0.375rem',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '1rem',
                  }}
                >
                  {wallets.map((w) => (
                    <option key={w.key} value={w.key}>
                      {w.name}
                      {w.supportsCip95 ? ' (CIP-95)' : ''}
                    </option>
                  ))}
                </select>
              </label>

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
              </fieldset>

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
                        onClick={reset}
                        style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}
                      >
                        Try again
                      </button>
                      {role === 'drep' && (
                        <>
                          <span style={{ color: 'var(--muted)', margin: '0 0.5rem' }}>or</span>
                          <a href="/drep" style={{ color: 'var(--accent)' }}>register as a DRep</a>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Connect button */}
              <button
                onClick={handleLogin}
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
                {busy ? 'Connecting...' : 'Connect and sign in'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
