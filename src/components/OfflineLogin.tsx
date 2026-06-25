// React island: offline (paste) login for SPOs (Calidus key) and CC members.
// Wallets do not yet expose Calidus / CC-hot signing, so the user signs the
// server challenge offline with cardano-signer and pastes the result back.
// All flow logic lives in offlineLogin.ts (tested); this is the UI shell.
import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { requestChallenge, loginOffline } from '@/lib/auth/offlineLogin.js';

type State =
  | { status: 'loading-challenge' }
  | { status: 'ready'; payload: string }
  | { status: 'submitting'; payload: string }
  | { status: 'challenge-error'; message: string }
  | { status: 'error'; payload: string; message: string }
  | { status: 'success'; userId: string; roles: string[] };

const ROLE_COPY: Record<'spo' | 'cc' | 'drep', { title: string; keyFile: string; what: string; notMember: string }> = {
  spo: {
    title: 'Sign in as a Stake Pool Operator',
    keyFile: 'calidus.skey',
    what: 'your Calidus key',
    notMember:
      'This Calidus key is not registered to an active stake pool on this network. Register a Calidus key for your pool first (CIP-151), then try again.',
  },
  cc: {
    title: 'Sign in as a Constitutional Committee member',
    keyFile: 'cc-hot.skey',
    what: 'your CC hot key',
    notMember:
      'This hot key is not an authorized, key-based Constitutional Committee credential on this network.',
  },
  drep: {
    title: 'Sign in as a DRep (CLI)',
    keyFile: 'drep.skey',
    what: 'your DRep key',
    notMember:
      'This key is not a registered, active DRep on this network. Register as a DRep first, then try again.',
  },
};

// Turn the server's terse error into a clear, role-aware sentence.
function friendlyError(error: string | undefined, role: 'spo' | 'cc' | 'drep'): string {
  const e = (error ?? '').toLowerCase();
  if (!e) return 'Login failed. Please try again.';
  if (e.includes('nonce')) return 'Your login challenge expired. Get a fresh challenge and sign it again.';
  if (e.includes('signature verification')) {
    return `We could not verify your signature. Make sure you signed the exact challenge with ${ROLE_COPY[role].what}.`;
  }
  if (e.includes('not an active spo') || e.includes('not an authorized cc') || e.includes('not an active drep'))
    return ROLE_COPY[role].notMember;
  if (e.includes('invalid request')) return 'The pasted signature or key was not in the expected format.';
  if (e.includes('could not read')) return error!;
  const msg = error!.charAt(0).toUpperCase() + error!.slice(1);
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}

export default function OfflineLogin({ role }: { role: 'spo' | 'cc' | 'drep' }) {
  const [state, setState] = useState<State>({ status: 'loading-challenge' });
  const [pasted, setPasted] = useState('');
  const copy = ROLE_COPY[role];

  const loadChallenge = useCallback(async () => {
    setState({ status: 'loading-challenge' });
    const res = await requestChallenge();
    if (res.ok && res.payload) {
      setState({ status: 'ready', payload: res.payload });
    } else {
      setState({ status: 'challenge-error', message: 'Could not reach the login service. Please try again.' });
    }
  }, []);

  useEffect(() => {
    void loadChallenge();
  }, [loadChallenge]);

  const payload = 'payload' in state ? state.payload : '';
  const command = `cardano-signer sign --data "${payload}" --secret-key ${copy.keyFile} --json`;

  async function handleSubmit() {
    if (!payload) return;
    setState({ status: 'submitting', payload });
    const result = await loginOffline({ role, payload, pastedText: pasted });
    if (result.ok && result.user) {
      setState({ status: 'success', userId: result.user.id, roles: result.user.roles });
      // Navigate to the discussions feed; the full page load lets the SSR header
      // pick up the new session cookie and render the signed-in state.
      window.location.assign('/discussions');
    } else {
      setState({ status: 'error', payload, message: friendlyError(result.error, role) });
    }
  }

  if (state.status === 'success') {
    return (
      <div style={{ maxWidth: '40rem' }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '1rem' }}>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>Logged in</p>
          <p style={{ margin: '0 0 0.25rem', fontSize: '0.875rem', color: 'var(--muted)' }}>User: {state.userId}</p>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>Roles: {state.roles.join(', ')}</p>
        </div>
      </div>
    );
  }

  const busy = state.status === 'submitting' || state.status === 'loading-challenge';

  return (
    <div style={{ maxWidth: '40rem' }}>
      <h2 style={{ fontSize: '1.125rem', margin: '0 0 0.75rem' }}>{copy.title}</h2>
      <p style={{ fontSize: '0.9375rem', color: 'var(--muted)', margin: '0 0 1.25rem' }}>
        Wallets cannot yet sign with {copy.what}, so sign the one-time challenge offline with{' '}
        <a href="https://github.com/gitmachtl/cardano-signer" target="_blank" rel="noopener noreferrer">cardano-signer</a>{' '}
        and paste the result. No transaction, no fees.
      </p>

      {state.status === 'challenge-error' ? (
        <div className="callout callout--error" role="alert">
          <div className="callout__body">
            {state.message}
            <div style={{ marginTop: '0.6rem' }}>
              <button type="button" onClick={loadChallenge} style={linkBtn}>Try again</button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <div style={labelRow}>
              <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>1. Sign this challenge</span>
              <button type="button" onClick={loadChallenge} disabled={busy} style={linkBtn}>Refresh</button>
            </div>
            <pre style={codeBlock}>{command}</pre>
            <p style={{ fontSize: '0.8125rem', color: 'var(--muted)', margin: '0.4rem 0 0' }}>
              The challenge is valid for a few minutes. If it expires, hit Refresh.
            </p>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>2. Paste the cardano-signer output</span>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              disabled={busy}
              rows={6}
              spellCheck={false}
              placeholder={'{ "signature": "...", "publicKey": "..." }'}
              style={textArea}
            />
          </label>

          {state.status === 'error' && (
            <div className="callout callout--error" role="alert">
              <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div className="callout__body">{state.message}</div>
            </div>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || pasted.trim().length === 0}
            style={{
              padding: '0.625rem 1.25rem',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: '0.375rem',
              fontSize: '1rem',
              fontWeight: 500,
              cursor: busy || pasted.trim().length === 0 ? 'not-allowed' : 'pointer',
              opacity: busy || pasted.trim().length === 0 ? 0.7 : 1,
              alignSelf: 'flex-start',
            }}
          >
            {state.status === 'submitting' ? 'Signing in...' : 'Sign in'}
          </button>
        </div>
      )}
    </div>
  );
}

const labelRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '0.3rem',
};
const codeBlock: CSSProperties = {
  margin: 0,
  padding: '0.7rem 0.85rem',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: '0.375rem',
  fontSize: '0.8125rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  color: 'var(--fg)',
};
const textArea: CSSProperties = {
  padding: '0.6rem 0.7rem',
  border: '1px solid var(--border)',
  borderRadius: '0.375rem',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: '0.875rem',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  resize: 'vertical',
};
const linkBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  cursor: 'pointer',
  padding: 0,
  font: 'inherit',
  textDecoration: 'underline',
};
