// React island: the phone side of desktop device pairing. Rendered by SignIn
// when its "Pair with desktop" method is active.
//
// Mobile browsers have no CIP-30 wallet extension and the cardano-signer flow
// needs a command line, so on a phone both other sign-in methods are dead ends.
// This one works everywhere: the phone shows a short code, a person already
// signed in on a desktop enters it and approves, and this device polls until
// that approval lands, then signs itself in.
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { formatPairingCode } from '@/lib/auth/pairingCode.js';
import { truncateIdMiddle } from '@/lib/forum/view.js';
import { cardStyle, stepHeadingStyle, linkBtnStyle, POST_LOGIN_DEST } from '@/components/signInStyles.js';

// Naming the approving account is the whole mitigation against being signed in
// by an account other than the one the user meant, so it must never degrade to
// an empty phrase. Display names are absent for SPO, CC and proposer logins and
// for DReps without metadata, so those fall back to a truncated account id,
// shortened the same way the account menu shortens it.
export function accountLabel(displayName: string | null, userId: string): string {
  const name = displayName?.trim();
  if (name) return name;
  return userId ? truncateIdMiddle(userId) : 'your account';
}

// ---- Persisted pairing state -------------------------------------------------

// localStorage, not sessionStorage: the flow asks the user to carry the phone to
// another device, which backgrounds the PWA and invites the OS to evict the
// process. Losing the secret there is the worst failure mode, because the
// desktop approval succeeds and the phone can never redeem it. The value lives
// at most ten minutes and is not a session by itself.
const PAIRING_KEY = 'dreptalk_pairing';

export interface StoredPairing {
  pairingId: string;
  deviceSecret: string;
  expiresAt: number;
}

// Exported for unit tests: `loadPairing`, `savePairing` and `clearPairing` are
// pure storage helpers and are cheaper to verify directly against a stubbed
// `localStorage` than through the component.
export function loadPairing(): StoredPairing | null {
  try {
    const raw = localStorage.getItem(PAIRING_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredPairing;
    if (stored.expiresAt * 1000 <= Date.now()) {
      localStorage.removeItem(PAIRING_KEY);
      return null;
    }
    return stored;
  } catch {
    localStorage.removeItem(PAIRING_KEY);
    return null;
  }
}

export function savePairing(stored: StoredPairing): void {
  try {
    localStorage.setItem(PAIRING_KEY, JSON.stringify(stored));
  } catch {
    // Storage may be unavailable (private browsing, quota). The pairing still
    // works for this page view, it just cannot survive the app being evicted.
  }
}

export function clearPairing(): void {
  try {
    localStorage.removeItem(PAIRING_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

// ---- Polling backoff ---------------------------------------------------------

// Starts at 2s and widens to 5s. A flat 2s interval would be up to 300 requests
// per pairing, which a per-IP limiter would read as abuse for users behind
// carrier-grade NAT, and 300 D1 reads per pairing is needless load.
export function nextDelay(current: number): number {
  return Math.min(current + 500, 5000);
}

const FIRST_DELAY_MS = 2000;

// ---- Network calls ------------------------------------------------------------

interface StartOk {
  ok: true;
  pairingId: string;
  deviceSecret: string;
  code: string;
  expiresAt: number;
}

function friendlyStartError(error: string | undefined): string {
  switch (error) {
    case 'rate_limited':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'forbidden':
      return 'Could not start pairing from this page. Please reload and try again.';
    default:
      return 'Could not start pairing right now. Please try again.';
  }
}

async function callPairStart(): Promise<StartOk | { ok: false; message: string }> {
  try {
    const res = await fetch('/api/auth/pair/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const data = (await res.json().catch(() => null)) as
      | StartOk
      | { ok: false; error?: string }
      | null;
    if (!data) return { ok: false, message: friendlyStartError(undefined) };
    if (!data.ok) return { ok: false, message: friendlyStartError(data.error) };
    return data;
  } catch {
    return { ok: false, message: 'Could not reach the server. Check your connection and try again.' };
  }
}

type PollTick =
  | { kind: 'pending' }
  | { kind: 'signed-in'; label: string }
  | { kind: 'failed' }
  | { kind: 'retryable-error' };

// Server error codes returned by /api/auth/pair/poll that no retry can recover.
// Either the pairing itself is dead (gone, expired, already claimed, or consumed
// by a session that then failed to mint), or this client is asking wrongly
// ('forbidden', 'invalid request'), which would repeat identically for the whole
// TTL. See src/pages/api/auth/pair/poll.ts.
const TERMINAL_POLL_ERRORS = new Set(['unknown', 'pairing_failed', 'forbidden', 'invalid request']);

async function callPairPoll(pairingId: string, deviceSecret: string): Promise<PollTick> {
  try {
    const res = await fetch('/api/auth/pair/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingId, deviceSecret }),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok: true; status: 'pending' }
      | { ok: true; status: 'signed-in'; user: { id: string; roles: string[]; displayName: string | null } }
      | { ok: false; error?: string }
      | null;
    if (!data) return { kind: 'retryable-error' };
    if (!data.ok) {
      if (data.error && TERMINAL_POLL_ERRORS.has(data.error)) return { kind: 'failed' };
      // Everything else, rate_limited (429), service unavailable (503), and any
      // error code this client does not recognize, leaves the pairing row
      // untouched, so it is safer to retry than to discard a still-valid
      // pairing. The stored expiresAt already bounds how long that can go on.
      return { kind: 'retryable-error' };
    }
    if (data.status === 'pending') return { kind: 'pending' };
    return { kind: 'signed-in', label: accountLabel(data.user.displayName, data.user.id) };
  } catch {
    // A dropped request while the phone is locked or out of signal is routine,
    // not a reason to give up on the pairing: retry on the next tick.
    return { kind: 'retryable-error' };
  }
}

// ---- Component state ----------------------------------------------------------

type PairState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'start-error'; message: string }
  // `code` is null when this pairing was restored from storage after the app
  // was relaunched: the code itself is never persisted (it is not needed to
  // redeem), so there is nothing to redisplay and the view shows a waiting state.
  | { phase: 'active'; pairingId: string; deviceSecret: string; expiresAt: number; code: string | null }
  | { phase: 'signed-in'; label: string }
  | { phase: 'failed' };

// ---- Styles ---------------------------------------------------------------

const codeDisplayStyle: CSSProperties = {
  display: 'block',
  margin: 0,
  padding: '1rem',
  textAlign: 'center',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm, 9px)',
  fontSize: '1.75rem',
  fontWeight: 700,
  letterSpacing: '0.15em',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'var(--fg)',
};

function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ---- Component ------------------------------------------------------------

export default function PairWithDesktop() {
  const [state, setState] = useState<PairState>({ phase: 'idle' });

  // Restore a still-valid pairing on mount and resume polling, so an evicted
  // and relaunched PWA continues instead of stranding the user. Does NOT start
  // a fresh pairing on mount: a stray page view must not mint a record.
  useEffect(() => {
    const stored = loadPairing();
    if (stored) {
      setState({
        phase: 'active',
        pairingId: stored.pairingId,
        deviceSecret: stored.deviceSecret,
        expiresAt: stored.expiresAt,
        code: null,
      });
    }
  }, []);

  async function handleStart() {
    setState({ phase: 'starting' });
    const result = await callPairStart();
    if (!result.ok) {
      // The stored pairing is deliberately left alone. Starting is rate limited,
      // so a "Get a new code" tap can fail while the current pairing is still
      // valid; discarding its secret up front would leave the user with nothing
      // for the rest of the window, and a reload can still resume it.
      setState({ phase: 'start-error', message: result.message });
      return;
    }
    // Success replaces the stored pairing, so storage always matches the code
    // on screen and no stale pairing can resurface on the next reload.
    savePairing({ pairingId: result.pairingId, deviceSecret: result.deviceSecret, expiresAt: result.expiresAt });
    setState({
      phase: 'active',
      pairingId: result.pairingId,
      deviceSecret: result.deviceSecret,
      expiresAt: result.expiresAt,
      code: result.code,
    });
  }

  function handleCancel() {
    clearPairing();
    setState({ phase: 'idle' });
  }

  const activePairingId = state.phase === 'active' ? state.pairingId : null;
  const activeDeviceSecret = state.phase === 'active' ? state.deviceSecret : null;
  const activeExpiresAt = state.phase === 'active' ? state.expiresAt : null;

  // A pairing that has already signed in must never be dragged back to a
  // failure: once the session cookie is set, a late 404 (a duplicate poll
  // losing the race for the single-winner claim) is not the truth about this
  // device. Success wins unconditionally.
  const failPairing = useCallback(() => {
    clearPairing();
    setState((prev) => (prev.phase === 'signed-in' ? prev : { phase: 'failed' }));
  }, []);

  // Poll while a pairing is active. Reacts to the page becoming visible again
  // so a phone that was locked while its owner walked to the desktop reacts at
  // once, instead of waiting out a long backoff interval.
  useEffect(() => {
    if (activePairingId === null || activeDeviceSecret === null || activeExpiresAt === null) return;
    const pairingId = activePairingId;
    const deviceSecret = activeDeviceSecret;
    const expiresAt = activeExpiresAt;

    let cancelled = false;
    // Exactly one poll may be outstanding. Without this, a visibility change
    // whose pending timeout had already fired would start a second chain (the
    // clearTimeout being a no-op), each chain re-arming its own timer: the
    // handles leak, the request volume multiplies, and the two chains race for
    // the same single-winner claim.
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = FIRST_DELAY_MS;

    async function tick() {
      if (cancelled || inFlight) return;
      // The pairing's own TTL is known locally, so an already-expired pairing
      // resolves without a wasted request instead of waiting for the server's 404.
      if (Date.now() >= expiresAt * 1000) {
        failPairing();
        return;
      }
      inFlight = true;
      let outcome: PollTick;
      try {
        outcome = await callPairPoll(pairingId, deviceSecret);
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      if (outcome.kind === 'pending' || outcome.kind === 'retryable-error') {
        delay = nextDelay(delay);
        timer = setTimeout(() => void tick(), delay);
        return;
      }
      if (outcome.kind === 'signed-in') {
        clearPairing();
        setState({ phase: 'signed-in', label: outcome.label });
        return;
      }
      // outcome.kind === 'failed': the pairing is gone, expired, already claimed
      // by another redeem, or spent by a session that then failed to mint. All
      // of these are terminal; the only way forward is a fresh pairing.
      failPairing();
    }

    timer = setTimeout(() => void tick(), delay);

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      // A poll already on the wire will re-arm the timer itself when it lands,
      // so there is nothing to hurry along here.
      if (inFlight) return;
      if (timer) clearTimeout(timer);
      void tick();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activePairingId, activeDeviceSecret, activeExpiresAt, failPairing]);

  // ---- Signed-in interstitial: never auto-redirects. A passive toast would be
  // missed and a pairing approved by the wrong account would sign this device
  // in silently; naming the account and requiring a tap is the mitigation.
  if (state.phase === 'signed-in') {
    return (
      <div style={cardStyle}>
        <p style={{ margin: 0, fontWeight: 600 }}>Pairing complete</p>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>
          This device is now signed in as {state.label}.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.location.assign(POST_LOGIN_DEST)}
          style={{ width: '100%', padding: '0.65rem 1rem', fontSize: '0.9375rem' }}
        >
          Continue as {state.label}
        </button>
      </div>
    );
  }

  if (state.phase === 'failed') {
    return (
      <div style={cardStyle}>
        <p style={{ margin: 0, color: 'var(--muted)' }}>
          This pairing could not be completed. Please start again.
        </p>
        <button type="button" className="btn btn-primary" onClick={handleStart} style={{ width: '100%', padding: '0.65rem 1rem', fontSize: '0.9375rem' }}>
          Start again
        </button>
      </div>
    );
  }

  if (state.phase === 'active') {
    return (
      <div style={cardStyle}>
        {state.code ? (
          <div>
            <span style={stepHeadingStyle}>Your pairing code</span>
            <code style={codeDisplayStyle}>{formatPairingCode(state.code)}</code>
            <p style={{ margin: '0.6rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)', lineHeight: 1.5 }}>
              Open Devices in the account menu on a device where you are already signed in to DRepTalk, and
              enter this code there. It expires at {formatExpiry(state.expiresAt)}.
            </p>
          </div>
        ) : (
          <div>
            <span style={stepHeadingStyle}>Waiting for approval</span>
            <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)', lineHeight: 1.5 }}>
              Reconnected to a pairing already in progress. If you still have the code, enter it on a
              signed-in device now. This pairing expires at {formatExpiry(state.expiresAt)}.
            </p>
          </div>
        )}

        <p role="status" aria-live="polite" style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>
          Waiting for approval...
        </p>

        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
          <button type="button" onClick={handleStart} style={linkBtnStyle}>
            Get a new code
          </button>
          <button type="button" onClick={handleCancel} style={linkBtnStyle}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // idle, starting: no pairing has been minted yet. start-error: a start
  // attempt failed, but a still-valid pairing minted earlier may remain in
  // localStorage (its stored state is deliberately left alone on a failed
  // retry, see handleStart above), even though this branch has nothing new
  // to show for it.
  return (
    <div style={cardStyle}>
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.9375rem', lineHeight: 1.5 }}>
        This device has no Cardano wallet extension. Instead, show a short code here and approve it from a
        device where you are already signed in to DRepTalk.
      </p>

      <button
        type="button"
        className="btn btn-primary"
        onClick={handleStart}
        disabled={state.phase === 'starting'}
        style={{ width: '100%', padding: '0.65rem 1rem', fontSize: '0.9375rem', opacity: state.phase === 'starting' ? 0.7 : 1 }}
      >
        {state.phase === 'starting' ? 'Starting...' : 'Show pairing code'}
      </button>

      {state.phase === 'start-error' && (
        <div className="callout callout--error" role="alert">
          <div className="callout__body">
            {state.message}
            <div style={{ marginTop: '0.6rem' }}>
              <button type="button" onClick={handleStart} style={linkBtnStyle}>
                Try again
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
