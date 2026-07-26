// React island: the desktop side of device pairing. Rendered on /devices/ for
// a signed-in user who wants to approve a phone (or other device) that is
// showing a short pairing code.
//
// Two steps, deliberately: entry (type the code) then confirmation (see what
// is asking for access before consenting). Device code phishing, where an
// attacker gets a target to approve their code, is the known weakness of every
// flow shaped like this one and cannot be fully eliminated. Showing the
// requesting device only after approval would defeat the one mitigation this
// screen can offer, so the confirmation step always renders before the code is
// spent.
import { useState, type FormEvent } from 'react';
import { normalizePairingCode, formatPairingCode } from '@/lib/auth/pairingCode.js';
import { describeUserAgent } from '@/lib/auth/deviceLabel.js';
import { formatRelativeTime } from '@/lib/forum/view.js';
import { cardStyle, stepHeadingStyle, fieldLabelStyle, inputStyle, linkBtnStyle } from '@/components/signInStyles.js';

// ---- Network calls ------------------------------------------------------------

interface LookupOk {
  ok: true;
  userAgent: string | null;
  createdAt: number;
}

// Shared between lookup and approve: both endpoints return the same negative
// shapes (see src/pages/api/auth/pair/lookup.ts and approve.ts).
function friendlyPairError(error: string | undefined): string {
  switch (error) {
    case 'unknown_code':
      return 'That code is not valid or has expired. Ask the device to show a new one.';
    case 'rate_limited':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'unauthorized':
      return 'Your session has expired. Please sign in again.';
    case 'forbidden':
      return 'Could not complete this from here. Please reload and try again.';
    default:
      return 'Could not complete this right now. Please try again.';
  }
}

async function callPairEndpoint(
  path: 'lookup' | 'approve',
  code: string,
): Promise<LookupOk | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api/auth/pair/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = (await res.json().catch(() => null)) as
      | LookupOk
      | { ok: true }
      | { ok: false; error?: string }
      | null;
    if (!data) return { ok: false, message: friendlyPairError(undefined) };
    if (!data.ok) return { ok: false, message: friendlyPairError(data.error) };
    return data as LookupOk;
  } catch {
    return { ok: false, message: 'Could not reach the server. Check your connection and try again.' };
  }
}

// ---- Component state ----------------------------------------------------------

type Step =
  | { phase: 'entry'; error: string | null }
  | { phase: 'looking-up' }
  | {
      phase: 'confirm';
      code: string;
      userAgent: string | null;
      createdAt: number;
      error: string | null;
      approving: boolean;
    }
  | { phase: 'done' };

// Error circle for the callout, matching the one used elsewhere in the sign-in
// flow (see SignIn.tsx).
const IconError = (
  <svg
    className="callout__icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

function ErrorCallout({ message }: { message: string }) {
  return (
    <div className="callout callout--error" role="alert">
      {IconError}
      <div className="callout__body">{message}</div>
    </div>
  );
}

export default function ApproveDevice() {
  const [input, setInput] = useState('');
  const [step, setStep] = useState<Step>({ phase: 'entry', error: null });

  async function handleContinue(e: FormEvent) {
    e.preventDefault();
    const code = normalizePairingCode(input);
    if (!code) {
      setStep({ phase: 'entry', error: 'That code is not valid or has expired. Ask the device to show a new one.' });
      return;
    }
    setStep({ phase: 'looking-up' });
    const result = await callPairEndpoint('lookup', code);
    if (!result.ok) {
      setStep({ phase: 'entry', error: result.message });
      return;
    }
    setStep({
      phase: 'confirm',
      code,
      userAgent: result.userAgent,
      createdAt: result.createdAt,
      error: null,
      approving: false,
    });
  }

  function handleCancel() {
    setStep({ phase: 'entry', error: null });
  }

  async function handleApprove() {
    if (step.phase !== 'confirm') return;
    const { code, userAgent, createdAt } = step;
    setStep({ phase: 'confirm', code, userAgent, createdAt, error: null, approving: true });
    const result = await callPairEndpoint('approve', code);
    if (!result.ok) {
      // Covers the race where a second person (or the same person on another
      // tab) approves the same code first: the lookup above already
      // succeeded, so this failure only surfaces here, on the confirm step,
      // with the same not-valid-or-expired wording and a way back to entry.
      setStep({ phase: 'confirm', code, userAgent, createdAt, error: result.message, approving: false });
      return;
    }
    setStep({ phase: 'done' });
  }

  function handlePairAnother() {
    setInput('');
    setStep({ phase: 'entry', error: null });
  }

  if (step.phase === 'done') {
    return (
      <div style={cardStyle}>
        <p style={{ margin: 0, fontWeight: 600 }}>Device paired</p>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>
          It should be signed in within a few seconds.
        </p>
        <button type="button" onClick={handlePairAnother} style={linkBtnStyle}>
          Pair another device
        </button>
      </div>
    );
  }

  if (step.phase === 'confirm') {
    const deviceLabel = describeUserAgent(step.userAgent);
    const requestedAgo = formatRelativeTime(step.createdAt * 1000, Date.now());
    return (
      <div style={cardStyle}>
        <div>
          <span style={stepHeadingStyle}>Confirm this device</span>
          <p style={{ margin: 0, fontSize: '0.9375rem', color: 'var(--fg)', lineHeight: 1.5 }}>
            A device is requesting access to your DRepTalk account.
          </p>
        </div>

        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.35rem 0.75rem', fontSize: '0.875rem' }}>
          <dt style={{ margin: 0, color: 'var(--muted)' }}>Code</dt>
          <dd style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 }}>
            {formatPairingCode(step.code)}
          </dd>
          <dt style={{ margin: 0, color: 'var(--muted)' }}>Device</dt>
          <dd style={{ margin: 0 }}>{deviceLabel}</dd>
          <dt style={{ margin: 0, color: 'var(--muted)' }}>Requested</dt>
          <dd style={{ margin: 0 }}>{requestedAgo}</dd>
        </dl>

        <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)', lineHeight: 1.5 }}>
          Only pair a device that is showing this code right now. DRepTalk will never ask you to enter a code
          that someone sent you.
        </p>
        <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.5 }}>
          The device information above comes from the device itself. It is a sanity check, not a security
          guarantee.
        </p>

        {step.error && <ErrorCallout message={step.error} />}

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleApprove}
            disabled={step.approving}
            style={{ flex: 1, padding: '0.65rem 1rem', fontSize: '0.9375rem', opacity: step.approving ? 0.7 : 1 }}
          >
            {step.approving ? 'Pairing...' : 'Pair this device'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleCancel}
            disabled={step.approving}
            style={{ padding: '0.65rem 1rem', fontSize: '0.9375rem' }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // entry, looking-up
  const looking = step.phase === 'looking-up';
  return (
    <div style={cardStyle}>
      <form onSubmit={handleContinue}>
        <label htmlFor="pairing-code" style={fieldLabelStyle}>
          Pairing code
        </label>
        <input
          id="pairing-code"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          maxLength={9}
          placeholder="XXXX-XXXX"
          disabled={looking}
          style={{ ...inputStyle, letterSpacing: '0.1em', textTransform: 'uppercase' }}
        />
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)', lineHeight: 1.5 }}>
          Enter the code shown on the device you want to sign in.
        </p>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={looking || input.trim().length === 0}
          style={{ width: '100%', marginTop: '1rem', padding: '0.65rem 1rem', fontSize: '0.9375rem', opacity: looking ? 0.7 : 1 }}
        >
          {looking ? 'Checking...' : 'Continue'}
        </button>
      </form>

      {step.phase === 'entry' && step.error && (
        <div style={{ marginTop: '1.25rem' }}>
          <ErrorCallout message={step.error} />
        </div>
      )}
    </div>
  );
}
