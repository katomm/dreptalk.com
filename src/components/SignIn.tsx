// React island: unified sign-in with two method tabs (wallet and cardano-signer).
// Consolidates WalletLogin.tsx and OfflineLogin.tsx into one coherent, polished
// component. Flow logic in walletLogin.ts and offlineLogin.ts is UNCHANGED.
import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { loginWithWallet } from '@/lib/auth/walletLogin.js';
import type { WalletApi } from '@/lib/auth/walletLogin.js';
import { requestChallenge, loginOffline } from '@/lib/auth/offlineLogin.js';
import { bytesToHex } from '@/lib/crypto/hex.js';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import WalletConnection from '@/components/WalletConnection.js';
import PairWithDesktop from '@/components/PairWithDesktop.js';
import { networkMismatchMessage, WALLET_NETWORK_MISMATCH } from '@/lib/wallet/networkGuard.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import {
  cardStyle,
  stepHeadingStyle,
  fieldLabelStyle,
  inputStyle,
  codeBlockStyle,
  linkBtnStyle,
  POST_LOGIN_DEST,
} from '@/components/signInStyles.js';

// ---- Types ------------------------------------------------------------------

type SignInMethod = 'wallet' | 'cardano-signer' | 'pair';

// Wallet flow roles: DRep, Proposer, or Delegator.
type WalletRole = 'drep' | 'proposer' | 'delegator';

// Cardano-signer flow roles: DRep, SPO, or CC (Proposer is wallet-only).
type SignerRole = 'drep' | 'spo' | 'cc';

// Which step the cardano-signer flow is in.
type SignerStep = 'identity' | 'sign';

type LoginState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'awaiting-signature' }
  | { status: 'success'; userId: string; roles: string[] }
  | { status: 'error'; message: string };

// ---- Error mapping ----------------------------------------------------------

// Maps terse server error codes to clear, role-aware sentences including a next
// step. Shared between wallet and cardano-signer paths.
function friendlyLoginError(
  error: string | undefined,
  role: WalletRole | SignerRole,
  network: CardanoNetwork,
): string {
  const e = (error ?? '').toLowerCase();
  if (!e) return 'Login failed. Please try again.';

  if (e.includes(WALLET_NETWORK_MISMATCH)) return networkMismatchMessage(network);

  if (e.includes('cip-95')) {
    return 'This wallet does not support CIP-95. Please use a DRep-capable wallet (e.g. Lace, Eternl, Typhon).';
  }
  if (e.includes('nonce')) {
    return 'Your login challenge expired. Get a fresh challenge and sign it again.';
  }
  if (e.includes('key-based drep in script flow')) {
    return 'That is a key-based DRep, not a script DRep. Turn off the "multisig / script DRep" toggle and sign in as a regular DRep (no Script DRep ID needed).';
  }
  if (e.includes('plutus script drep unsupported')) {
    return 'This is a Plutus-script DRep, which cannot sign in: there are no keys to prove membership. Only native-script (multisig) DReps are supported here.';
  }
  if (e.includes('not a script drep member')) {
    return 'This key is not one of the script DRep’s authorized signers, or the DRep ID is wrong. Check the ID and sign with a member key.';
  }
  if (e.includes('signature verification') || e.includes('invalid address in signature')) {
    return 'We could not verify your signature. Please try signing again.';
  }
  if (e.includes('address type mismatch')) {
    return role === 'drep'
      ? 'This wallet did not sign as a DRep. Pick a wallet/account that has a DRep key (CIP-95) and keep the DRep role selected, or register as a DRep first.'
      : 'This wallet did not sign with a reward address. Use the wallet that submitted the governance action and select the Proposer role.';
  }
  if (e.includes('not an active drep')) {
    return 'This key is not a registered, active DRep on this network. Register as a DRep to take part.';
  }
  if (e.includes('not an active spo')) {
    return 'This Calidus key is not registered to an active stake pool on this network. Register a Calidus key for your pool first (CIP-151), then try again.';
  }
  if (e.includes('not an authorized cc')) {
    return 'This hot key is not an authorized, key-based Constitutional Committee credential on this network.';
  }
  if (e.includes('not a proposer or moderator')) {
    return 'This wallet has not submitted a governance action and is not a listed moderator, so it cannot sign in.';
  }
  if (e.includes('could not read')) return error!;
  if (e.includes('invalid request')) {
    return 'Something was off with the login request, or the pasted output was not in the expected format. Please try again.';
  }
  if (e.includes('login failed') || e.includes('service unavailable') || e.includes('internal')) {
    return 'Login failed, the service may be busy. Please try again.';
  }
  const msg = error!.charAt(0).toUpperCase() + error!.slice(1);
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}

// ---- Shared primitives ------------------------------------------------------

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

// Two-or-more button toggle for role and method choices. Active state is a
// subtle tint, not a solid fill, so it never competes with the primary button.
//
// `wrap` + `minButtonInlineSize` are opt-in: only the three-way sign-in method
// control needs to stack on narrow screens, so the two-and-three-way role
// controls (which already fit comfortably) keep their original single-row layout.
function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  wrap = false,
  minButtonInlineSize,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  disabled?: boolean;
  ariaLabel: string;
  wrap?: boolean;
  minButtonInlineSize?: string;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        flexWrap: wrap ? 'wrap' : 'nowrap',
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
              minInlineSize: minButtonInlineSize,
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

// ---- Icons ------------------------------------------------------------------

const IconPersonFilled = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M12 14c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" />
  </svg>
);

const IconPersonOutline = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20v-1a6 6 0 0 1 12 0v1" />
  </svg>
);

// Server/node icon for SPO.
const IconServer = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
);

// Building/institution icon for CC member.
const IconBuilding = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="9" width="18" height="12" />
    <path d="M3 9 12 3l9 6" />
    <line x1="9" y1="21" x2="9" y2="15" />
    <line x1="15" y1="21" x2="15" y2="15" />
    <line x1="9" y1="12" x2="9.01" y2="12" />
    <line x1="12" y1="12" x2="12.01" y2="12" />
    <line x1="15" y1="12" x2="15.01" y2="12" />
  </svg>
);

// Wallet/credit-card icon for the "Connect a wallet" tab.
const IconWallet = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20" />
    <circle cx="17" cy="15" r="1" fill="currentColor" />
  </svg>
);

// Terminal/CLI icon for the "cardano-signer" tab.
const IconTerminal = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

// Mobile phone icon for the "Pair with desktop" tab.
const IconPhone = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="7" y="2" width="10" height="20" rx="2" />
    <line x1="11" y1="18" x2="13" y2="18" />
  </svg>
);

// Shield-check for the primary sign-in button and trust note.
const IconShieldCheck = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

// Info circle for the multisig toggle hint.
const IconInfo = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: 'var(--muted)' }}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="8.01" />
    <line x1="12" y1="12" x2="12" y2="16" />
  </svg>
);

// Error circle for callout.
const IconError = (
  <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

// ---- Per-role metadata for cardano-signer path ------------------------------

const SIGNER_ROLE_META: Record<SignerRole, { keyFile: string }> = {
  drep: { keyFile: 'drep.skey' },
  spo: { keyFile: 'calidus.skey' },
  cc: { keyFile: 'cc-hot.skey' },
};

// ---- Trust note (reused in both tabs) ---------------------------------------

function TrustNote() {
  return (
    <p style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', margin: 0, fontSize: '0.8125rem', color: 'var(--muted)', textAlign: 'center' }}>
      {IconShieldCheck}
      You will sign a one-time message. This does not submit a transaction or cost fees.
    </p>
  );
}

// ---- Multisig toggle row + Script DRep ID input ----------------------------

interface MultisigPanelProps {
  enabled: boolean;
  onToggle: () => void;
  scriptId: string;
  onScriptIdChange: (v: string) => void;
  disabled: boolean;
}

function MultisigPanel({ enabled, onToggle, scriptId, onScriptIdChange, disabled }: MultisigPanelProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* Toggle row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="multisig-switch-label"
          aria-describedby="multisig-switch-hint"
          onClick={onToggle}
          disabled={disabled}
          style={{
            appearance: 'none',
            WebkitAppearance: 'none',
            width: '2.25rem',
            height: '1.25rem',
            borderRadius: '999px',
            background: enabled ? 'var(--accent)' : 'var(--border)',
            border: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            flexShrink: 0,
            position: 'relative',
            transition: 'background 0.15s ease',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: '0.125rem',
              left: enabled ? 'calc(100% - 1.125rem)' : '0.125rem',
              width: '1rem',
              height: '1rem',
              borderRadius: '50%',
              background: '#fff',
              transition: 'left 0.15s ease',
            }}
          />
        </button>
        <span id="multisig-switch-label" style={{ fontSize: '0.875rem', color: 'var(--fg)', userSelect: 'none' }}>
          This is a multisig / script DRep
        </span>
        <span
          aria-hidden="true"
          title="A script DRep is controlled by a native multisig script, not a single key. Enter the DRep ID and prove membership by signing with one of its authorized keys."
        >
          {IconInfo}
        </span>
        {/* Same explanation as the tooltip, exposed to assistive tech (the icon's
            title alone is not announced on a non-focusable span). */}
        <span id="multisig-switch-hint" className="sr-only">
          A script DRep is controlled by a native multisig script, not a single key. Enter the DRep ID and prove membership by signing with one of its authorized keys.
        </span>
      </div>

      {/* Script DRep ID input, visible only when the toggle is on */}
      {enabled && (
        <div>
          <label htmlFor="script-drep-id" style={fieldLabelStyle}>Script DRep ID</label>
          <input
            id="script-drep-id"
            type="text"
            value={scriptId}
            onChange={(e) => onScriptIdChange(e.target.value)}
            placeholder="drep1..."
            disabled={disabled}
            style={inputStyle}
          />
        </div>
      )}
    </div>
  );
}

// ---- Error / status callout -------------------------------------------------

interface StatusCalloutProps {
  loginState: LoginState;
  onReset: () => void;
  role: WalletRole | SignerRole;
  method: SignInMethod;
}

function StatusCallout({ loginState, onReset, role, method }: StatusCalloutProps) {
  if (loginState.status === 'connecting') {
    return (
      <p role="status" aria-live="polite" style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
        Connecting to wallet...
      </p>
    );
  }
  if (loginState.status === 'awaiting-signature') {
    return (
      <p role="status" aria-live="polite" style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
        {method === 'cardano-signer'
          ? 'Verifying your signature...'
          : 'Please sign the login challenge in your wallet.'}
      </p>
    );
  }
  if (loginState.status === 'error') {
    const isDRep = role === 'drep';
    return (
      <div className="callout callout--error" role="alert">
        {IconError}
        <div className="callout__body">
          {loginState.message}
          <div style={{ marginTop: '0.6rem' }}>
            <button type="button" onClick={onReset} style={linkBtnStyle}>
              Try again
            </button>
            {isDRep && (
              <>
                <span style={{ color: 'var(--muted)', margin: '0 0.5rem' }}>or</span>
                <a href="/register-drep/" style={{ color: 'var(--accent)', fontSize: '0.8125rem' }}>
                  register as a DRep
                </a>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
  return null;
}

// ---- Wallet tab -------------------------------------------------------------

interface WalletTabProps {
  network: CardanoNetwork;
  loginState: LoginState;
  onLoginStateChange: (s: LoginState) => void;
  // Scan owned by the SignIn island, which also needs it to decide the default
  // method. Passing it down keeps one polling scan per page instead of two.
  walletScan: ReturnType<typeof useCardanoWallets>;
}

function WalletTab({ network, loginState, onLoginStateChange, walletScan }: WalletTabProps) {
  const { wallets, selected: selectedWallet, setSelected: setSelectedWallet, scanning } = walletScan;
  const [role, setRole] = useState<WalletRole>('drep');
  const [multisigEnabled, setMultisigEnabled] = useState(false);
  const [scriptId, setScriptId] = useState('');

  // Preselect role from ?role= deep link.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('role');
    if (r === 'drep' || r === 'proposer' || r === 'delegator') setRole(r);
  }, []);

  // Reset multisig state when switching away from DRep.
  function handleRoleChange(r: WalletRole) {
    setRole(r);
    if (r !== 'drep') {
      setMultisigEnabled(false);
      setScriptId('');
    }
    onLoginStateChange({ status: 'idle' });
  }

  const busy = loginState.status === 'connecting' || loginState.status === 'awaiting-signature';

  async function doWalletLogin() {
    const walletInfo = wallets.find((w) => w.key === selectedWallet);
    if (!walletInfo) return;

    onLoginStateChange({ status: 'connecting' });

    const multisig =
      role === 'drep' && multisigEnabled && scriptId.trim()
        ? { scriptDrepId: scriptId.trim(), keyChoice: 'drep' as const }
        : undefined;

    const signRole: WalletRole = multisig ? 'drep' : role;
    let api: WalletApi;
    try {
      const enableOpts =
        walletInfo.supportsCip95 || signRole === 'drep' ? { extensions: [{ cip: 95 }] } : undefined;
      api = await walletInfo.raw.enable(enableOpts);
    } catch {
      onLoginStateChange({ status: 'error', message: 'Wallet connection was rejected.' });
      return;
    }

    onLoginStateChange({ status: 'awaiting-signature' });

    const result = await loginWithWallet(api, signRole, network, multisig ? { multisig } : undefined);

    if (result.ok && result.user) {
      rememberWallet(selectedWallet);
      onLoginStateChange({ status: 'success', userId: result.user.id, roles: result.user.roles });
      window.location.assign(POST_LOGIN_DEST);
    } else {
      onLoginStateChange({ status: 'error', message: friendlyLoginError(result.error, signRole, network) });
    }
  }

  if (wallets.length === 0) {
    // While the scan is still running, no verdict has been reached yet: saying
    // "no wallet detected" would be a false statement on a device that has one,
    // and it is precisely the dead end the pairing method exists to route around.
    // Show a neutral interim state instead and only claim absence once the scan
    // has actually closed with nothing found.
    return (
      <div style={cardStyle}>
        <p role="status" aria-live="polite" style={{ color: 'var(--muted)', margin: 0 }}>
          {scanning
            ? 'Looking for a wallet extension...'
            : 'No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).'}
        </p>
      </div>
    );
  }

  const signInDisabled = busy || (multisigEnabled && role === 'drep' && !scriptId.trim());

  return (
    <div style={cardStyle}>
      {/* Step 1: wallet picker */}
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

      {/* Step 2: role */}
      <div>
        <span style={stepHeadingStyle}>2. Sign in as</span>
        <SegmentedControl
          ariaLabel="Sign in as"
          value={role}
          onChange={handleRoleChange}
          disabled={busy}
          options={[
            { value: 'drep', label: 'DRep', icon: IconPersonFilled },
            { value: 'proposer', label: 'Proposer', icon: IconPersonOutline },
            { value: 'delegator', label: 'Delegator', icon: IconPersonOutline },
          ]}
        />
        {role === 'delegator' && (
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)', lineHeight: 1.5 }}>
            Sign in with your wallet to see how your DRep votes and get notified. Delegators cannot post or vote.
          </p>
        )}
      </div>

      {/* Multisig toggle, DRep only */}
      {role === 'drep' && (
        <MultisigPanel
          enabled={multisigEnabled}
          onToggle={() => { setMultisigEnabled((v) => !v); onLoginStateChange({ status: 'idle' }); }}
          scriptId={scriptId}
          onScriptIdChange={setScriptId}
          disabled={busy}
        />
      )}

      {/* Primary action */}
      <button
        type="button"
        className="btn btn-primary"
        onClick={doWalletLogin}
        disabled={signInDisabled}
        style={{ width: '100%', padding: '0.65rem 1rem', fontSize: '0.9375rem', opacity: signInDisabled ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
      >
        {IconShieldCheck}
        {busy ? 'Signing in...' : role === 'delegator' ? 'Track my delegation' : 'Sign in with wallet'}
      </button>

      <TrustNote />

      <StatusCallout
        loginState={loginState}
        onReset={() => onLoginStateChange({ status: 'idle' })}
        role={role}
        method="wallet"
      />
    </div>
  );
}

// ---- cardano-signer tab -----------------------------------------------------

interface SignerTabProps {
  network: CardanoNetwork;
  loginState: LoginState;
  onLoginStateChange: (s: LoginState) => void;
}

function SignerTab({ network, loginState, onLoginStateChange }: SignerTabProps) {
  const [role, setRole] = useState<SignerRole>('drep');
  const [step, setStep] = useState<SignerStep>('identity');
  const [multisigEnabled, setMultisigEnabled] = useState(false);
  const [scriptId, setScriptId] = useState('');
  const [challenge, setChallenge] = useState('');
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);

  const busy = loginState.status === 'awaiting-signature';

  // Preselect role from ?role= deep link (DRep / SPO / CC).
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('role');
    if (r === 'drep' || r === 'spo' || r === 'cc') setRole(r);
  }, []);

  // Fetch a challenge when we enter the sign step.
  const loadChallenge = useCallback(async () => {
    setChallenge('');
    setPasted('');
    const res = await requestChallenge();
    if (res.ok && res.payload) setChallenge(res.payload);
  }, []);

  useEffect(() => {
    if (step === 'sign') void loadChallenge();
  }, [step, loadChallenge]);

  // Reset multisig when switching away from DRep.
  function handleRoleChange(r: SignerRole) {
    setRole(r);
    if (r !== 'drep') {
      setMultisigEnabled(false);
      setScriptId('');
    }
    // Stay on identity step, but reset any error.
    onLoginStateChange({ status: 'idle' });
  }

  // Go from identity selection to the sign step.
  function handleContinue() {
    onLoginStateChange({ status: 'idle' });
    setStep('sign');
  }

  async function refreshChallenge() {
    onLoginStateChange({ status: 'idle' });
    void loadChallenge();
  }

  const keyFile = SIGNER_ROLE_META[role].keyFile;
  const dataHex = challenge ? bytesToHex(new TextEncoder().encode(challenge)) : '';
  const command = challenge
    ? `cardano-signer sign --data-hex "${dataHex}" --secret-key ${keyFile} --json`
    : '';

  async function copyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked in an insecure context; the command stays selectable.
    }
  }

  async function doPasteLogin() {
    if (!challenge) return;
    onLoginStateChange({ status: 'awaiting-signature' });

    const scriptDrepId = role === 'drep' && multisigEnabled && scriptId.trim() ? scriptId.trim() : undefined;
    // SPO and CC never use scriptDrepId; the offline flow treats 'spo'/'cc'/'drep' as OfflineRole.
    const offlineRole = role; // All three match OfflineRole exactly.

    const r = await loginOffline({
      role: offlineRole,
      payload: challenge,
      pastedText: pasted,
      scriptDrepId,
    });

    if (r.ok && r.user) {
      window.location.assign(POST_LOGIN_DEST);
    } else {
      onLoginStateChange({ status: 'error', message: friendlyLoginError(r.error, role, network) });
      // Challenge is single-use; refresh so the user can retry without reloading.
      void loadChallenge();
    }
  }

  const pasteDisabled = busy || !challenge || !pasted.trim();

  return (
    <div style={cardStyle}>
      {/* Role selection (identity step and sign step show it) */}
      <div>
        <span style={stepHeadingStyle}>Sign in as</span>
        <SegmentedControl
          ariaLabel="Sign in as"
          value={role}
          onChange={handleRoleChange}
          disabled={busy || step === 'sign'}
          options={[
            { value: 'drep', label: 'DRep', icon: IconPersonFilled },
            { value: 'spo', label: 'SPO', icon: IconServer },
            { value: 'cc', label: 'CC member', icon: IconBuilding },
          ]}
        />
      </div>

      {/* Multisig toggle, DRep only */}
      {role === 'drep' && (
        <MultisigPanel
          enabled={multisigEnabled}
          onToggle={() => { setMultisigEnabled((v) => !v); onLoginStateChange({ status: 'idle' }); }}
          scriptId={scriptId}
          onScriptIdChange={setScriptId}
          disabled={busy || step === 'sign'}
        />
      )}

      {/* Identity step: just the Continue button */}
      {step === 'identity' && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleContinue}
          style={{ width: '100%', padding: '0.65rem 1rem', fontSize: '0.9375rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
        >
          Continue
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
      )}

      {/* Sign step: command block + paste */}
      {step === 'sign' && (
        <>
          {/* Step 1: sign this challenge */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <span style={{ ...fieldLabelStyle, marginBottom: 0 }}>1. Sign this challenge</span>
              <button type="button" onClick={refreshChallenge} disabled={busy} style={linkBtnStyle}>
                Refresh
              </button>
            </div>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem', color: 'var(--muted)', lineHeight: 1.5 }}>
              Run this command locally, then paste the JSON output below. The challenge expires after a few minutes.
            </p>
            <code style={codeBlockStyle}>
              {command || 'Loading challenge...'}
            </code>
            {command && (
              <button
                type="button"
                onClick={copyCommand}
                className="btn btn-secondary"
                style={{ marginTop: '0.5rem', padding: '0.3rem 0.7rem', fontSize: '0.8125rem' }}
              >
                {copied ? 'Copied' : 'Copy command'}
              </button>
            )}
          </div>

          {/* Step 2: paste output */}
          <div>
            <label htmlFor="signer-output" style={fieldLabelStyle}>
              2. Paste the cardano-signer output
            </label>
            <textarea
              id="signer-output"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={'{ "signature": "...", "publicKey": "..." }'}
              rows={5}
              disabled={busy}
              spellCheck={false}
              style={{
                ...inputStyle,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '0.8125rem',
                resize: 'vertical',
              }}
            />
          </div>

          {/* Submit */}
          <button
            type="button"
            className="btn btn-primary"
            onClick={doPasteLogin}
            disabled={pasteDisabled}
            style={{ width: '100%', padding: '0.65rem 1rem', fontSize: '0.9375rem', opacity: pasteDisabled ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
          >
            {IconShieldCheck}
            {busy ? 'Verifying...' : 'Sign in with pasted signature'}
          </button>

          <TrustNote />

          <StatusCallout
            loginState={loginState}
            onReset={() => { onLoginStateChange({ status: 'idle' }); }}
            role={role}
            method="cardano-signer"
          />

          {/* Back to identity step */}
          <div style={{ textAlign: 'center' }}>
            <button
              type="button"
              onClick={() => { setStep('identity'); onLoginStateChange({ status: 'idle' }); }}
              style={linkBtnStyle}
              disabled={busy}
            >
              Change role
            </button>
          </div>
        </>
      )}

      {/* Trust note on the identity step too */}
      {step === 'identity' && <TrustNote />}
    </div>
  );
}

// ---- Main SignIn island ------------------------------------------------------

interface SignInProps {
  // Resolved at build time in the .astro shell; defaults to preprod. Drives
  // the CIP-19 type-6 DRep address header when signing.
  network?: CardanoNetwork;
}

export default function SignIn({ network = 'preprod' }: SignInProps) {
  const [method, setMethod] = useState<SignInMethod>('wallet');
  const [loginState, setLoginState] = useState<LoginState>({ status: 'idle' });
  // Set once the method is decided for good: by a role deep link or by the user
  // picking a tab. After that nothing may move the method under them.
  const [methodSettled, setMethodSettled] = useState(false);
  const walletScan = useCardanoWallets();
  const { wallets, scanning } = walletScan;

  // SPO and CC sign offline only, so their entry links open cardano-signer.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('role');
    if (r === 'spo' || r === 'cc') {
      setMethod('cardano-signer');
      setMethodSettled(true);
    }
  }, []);

  // With no CIP-30 wallet injected (mobile browsers and the installed PWA) the
  // wallet tab is a dead end, so pairing is preselected instead. Extensions
  // inject window.cardano asynchronously, usually after this island mounts, so
  // this waits for the scan window to close empty: a one-shot check at mount
  // would send desktop users who do have a wallet to the pairing tab.
  //
  // Touch-only devices skip that wait. No mobile browser has a CIP-30 extension,
  // so there is nothing for the scan to find and making a phone stare at a
  // wallet card for the full scan window helps nobody. A device with any fine
  // pointer or hover is treated as a desktop and still waits.
  useEffect(() => {
    if (methodSettled || wallets.length > 0) return;
    const touchOnly =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(any-hover: none) and (any-pointer: coarse)').matches;
    if (scanning && !touchOnly) return;
    setMethod('pair');
  }, [methodSettled, scanning, wallets.length]);

  // Reset transient login state when switching methods.
  function handleMethodChange(m: SignInMethod) {
    setMethod(m);
    setMethodSettled(true);
    setLoginState({ status: 'idle' });
  }

  // Success screen: shown regardless of method.
  if (loginState.status === 'success') {
    return (
      <div style={cardStyle}>
        <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>Signed in</p>
        <p style={{ margin: '0 0 0.25rem', fontSize: '0.875rem', color: 'var(--muted)' }}>
          User: {loginState.userId}
        </p>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>
          Roles: {loginState.roles.join(', ')}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Method tabs: styled as a segmented control. Three options no longer fit
          one row on a phone, so this instance wraps to a stacked, one-per-row
          layout below roughly 30rem; the role controls elsewhere keep their
          original single-row behaviour. */}
      <SegmentedControl
        ariaLabel="Sign-in method"
        value={method}
        onChange={handleMethodChange}
        wrap
        minButtonInlineSize="10rem"
        options={[
          { value: 'wallet', label: 'Connect a wallet', icon: IconWallet },
          { value: 'cardano-signer', label: 'Sign with cardano-signer', icon: IconTerminal },
          { value: 'pair', label: 'Pair with desktop', icon: IconPhone },
        ]}
      />

      {/* Tab panels */}
      {method === 'wallet' ? (
        <WalletTab
          network={network}
          loginState={loginState}
          onLoginStateChange={setLoginState}
          walletScan={walletScan}
        />
      ) : method === 'cardano-signer' ? (
        <SignerTab
          network={network}
          loginState={loginState}
          onLoginStateChange={setLoginState}
        />
      ) : (
        <PairWithDesktop />
      )}
    </div>
  );
}
