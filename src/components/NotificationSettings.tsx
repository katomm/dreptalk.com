// React island: the push notifications card on /notifications. A connect flow
// registers the service worker, asks for permission, and subscribes this
// device; a master toggle turns all event prefs on or off; the event-type
// matrix tunes them individually. Visible to every signed-in writer; the page
// passes an empty vapidPublicKey when push is not configured on this
// deployment yet.
import { useEffect, useState } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { fromBase64Url } from '@/lib/crypto/base64url.js';
import { relativeTime } from '@/lib/notifications/inboxView.js';
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';
import NotificationPrefsMatrix, { setAllPrefs } from './NotificationPrefsMatrix.tsx';

// Client-safe channel projection, mirrors ClientChannel from channelView but
// without the server-only channel kind. Shared with TelegramSettings.
export interface ClientChannelProps {
  id: string;
  createdAt: number;
  deliveredUntil: number;
  label: string | null;
  fingerprint: string | null;
}

export interface NotificationSettingsProps {
  channels: ClientChannelProps[];
  prefs: Record<NotificationEventType, boolean>;
  vapidPublicKey: string;
}

type ConnectPhase =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'blocked' }
  | { status: 'error'; message: string };

function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

const utf8 = new TextEncoder();

// Same algorithm as endpointFingerprint on the server: first 12 lowercase hex
// chars of SHA-256(endpoint). Lets this device recognize its own subscription
// row among the connected channels.
async function fingerprintEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8.encode(endpoint));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default function NotificationSettings({ channels, prefs, vapidPublicKey }: NotificationSettingsProps) {
  const [devices, setDevices] = useState<ClientChannelProps[]>(channels);
  const [phase, setPhase] = useState<ConnectPhase>({ status: 'idle' });
  const [prefState, setPrefState] = useState<Record<NotificationEventType, boolean>>(prefs);
  const [prefError, setPrefError] = useState<string | null>(null);
  // Fingerprint of this device's own push subscription, resolved on mount.
  const [deviceFingerprint, setDeviceFingerprint] = useState<string | null>(null);
  // Per-device test-push state, keyed by channel id.
  const [testState, setTestState] = useState<
    Record<string, { status: 'sending' } | { status: 'scheduled'; delaySeconds: number } | { status: 'error'; message: string }>
  >({});

  // The island lives inside the collapsed <details id="notification-settings">
  // on /notifications. Anchor links alone only scroll there; this opens the
  // section too, on every click of such a link and on a deep link with the
  // hash already set.
  useEffect(() => {
    const openSection = () => {
      const details = document.getElementById('notification-settings');
      if (details instanceof HTMLDetailsElement) details.open = true;
    };
    if (window.location.hash === '#notification-settings') openSection();
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('a[href="#notification-settings"]')) openSection();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Resolve this device's subscription fingerprint so its row reads "This
  // device" and the enable button hides once connected.
  useEffect(() => {
    if (!pushSupported()) return;
    let cancelled = false;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration('/push-sw.js');
        const sub = await reg?.pushManager.getSubscription();
        if (!sub) return;
        const fp = await fingerprintEndpoint(sub.endpoint);
        if (!cancelled) setDeviceFingerprint(fp);
      } catch {
        // No usable subscription; leave every row as a generic "Device".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!vapidPublicKey) {
    return (
      <p style={{ margin: 0, color: 'var(--muted)', maxWidth: '32rem' }}>
        Push notifications are not configured on this deployment yet.
      </p>
    );
  }

  if (!pushSupported()) {
    return (
      <p style={{ margin: 0, color: 'var(--muted)', maxWidth: '32rem' }}>
        Push is not supported in this browser. On iPhone and iPad it only works after{' '}
        <a href="/help/add-to-home-screen/" style={{ color: 'var(--accent)' }}>
          adding DRepTalk to the home screen
        </a>
        .
      </p>
    );
  }

  async function handleMasterToggle() {
    const next = !masterOn;
    const prev = prefState;
    setPrefError(null);
    setPrefState({ reply: next, mention: next, governance: next });
    const ok = await setAllPrefs('webpush', next);
    if (!ok) {
      setPrefState(prev);
      setPrefError('Could not save that setting. Please try again.');
    }
  }

  async function handlePrefToggle(eventType: NotificationEventType, enabled: boolean) {
    setPrefError(null);
    const prev = prefState;
    setPrefState((p) => ({ ...p, [eventType]: enabled }));
    try {
      const res = await fetchWithTimeout('/api/notifications/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'webpush', eventType, enabled }),
      });
      if (!res.ok) {
        setPrefState(prev);
        setPrefError('Could not save that setting. Please try again.');
      }
    } catch {
      setPrefState(prev);
      setPrefError('Could not save that setting. Please try again.');
    }
  }

  async function handleEnable() {
    setPhase({ status: 'connecting' });
    try {
      const reg = await navigator.serviceWorker.register('/push-sw.js');
      const permission = await Notification.requestPermission();
      if (permission === 'denied') {
        setPhase({ status: 'blocked' });
        return;
      }
      if (permission !== 'granted') {
        setPhase({ status: 'idle' });
        return;
      }

      // A leftover subscription bound to a DIFFERENT VAPID key (e.g. after a
      // key rotation) makes subscribe() throw InvalidStateError. Reuse a
      // matching subscription as is; unsubscribe a mismatched one first so the
      // fresh subscribe below cannot fail on it.
      const appServerKey = fromBase64Url(vapidPublicKey);
      const existing = await reg.pushManager.getSubscription();
      let sub = existing;
      if (existing) {
        const existingKey = existing.options.applicationServerKey
          ? new Uint8Array(existing.options.applicationServerKey as ArrayBuffer)
          : null;
        const sameKey =
          existingKey !== null &&
          existingKey.length === appServerKey.length &&
          existingKey.every((b, i) => b === appServerKey[i]);
        if (!sameKey) {
          await existing.unsubscribe();
          sub = null;
        }
      }
      sub ??= await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
      });
      const subJson = sub.toJSON();

      const res = await fetchWithTimeout('/api/notifications/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'webpush',
          subscription: {
            endpoint: subJson.endpoint,
            keys: { p256dh: subJson.keys?.p256dh, auth: subJson.keys?.auth },
          },
        }),
      });
      if (!res.ok) {
        setPhase({ status: 'error', message: 'Could not save this device. Please try again.' });
        return;
      }
      const { id } = (await res.json()) as { id: string };
      const fp = await fingerprintEndpoint(sub.endpoint);
      setDeviceFingerprint(fp);
      const now = Date.now();
      // A repeat enable on an already-connected device returns the existing
      // row's id (server dedupes by endpoint); do not append a duplicate row.
      setDevices((prev) =>
        prev.some((d) => d.id === id)
          ? prev
          : [...prev, { id, createdAt: now, deliveredUntil: now, label: null, fingerprint: fp }],
      );
      setPhase({ status: 'idle' });
    } catch {
      setPhase({ status: 'error', message: 'Could not enable push notifications. Please try again.' });
    }
  }

  async function handleRemove(id: string) {
    const prevDevices = devices;
    setDevices((prev) => prev.filter((d) => d.id !== id));
    try {
      const res = await fetchWithTimeout('/api/notifications/channels', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        setDevices(prevDevices);
      }
    } catch {
      setDevices(prevDevices);
    }
  }

  async function handleTest(id: string) {
    setTestState((prev) => ({ ...prev, [id]: { status: 'sending' } }));
    try {
      const res = await fetchWithTimeout('/api/notifications/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.status === 429) {
        setTestState((prev) => ({ ...prev, [id]: { status: 'error', message: 'Too many test notifications. Please wait a bit.' } }));
        return;
      }
      if (!res.ok) {
        setTestState((prev) => ({ ...prev, [id]: { status: 'error', message: 'Could not send a test. Please try again.' } }));
        return;
      }
      const { delayMs } = (await res.json()) as { delayMs: number };
      setTestState((prev) => ({ ...prev, [id]: { status: 'scheduled', delaySeconds: Math.round(delayMs / 1000) } }));
    } catch {
      setTestState((prev) => ({ ...prev, [id]: { status: 'error', message: 'Could not send a test. Please try again.' } }));
    }
  }

  const masterOn = Object.values(prefState).some(Boolean);
  const connecting = phase.status === 'connecting';
  const thisDeviceConnected =
    deviceFingerprint !== null && devices.some((d) => d.fingerprint === deviceFingerprint);
  const now = Date.now();

  return (
    <div className="nset__card">
      <div className="nset__head">
        <span className="nset__icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" />
          </svg>
        </span>
        <div className="nset__headtext">
          <h3 className="nset__title">Push notifications</h3>
          <p className="nset__cardsub">Get notified on this device when important things happen.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={masterOn}
          aria-label="Push notifications"
          className="nset__switch"
          onClick={() => void handleMasterToggle()}
        />
      </div>

      {!masterOn && <p className="nset__off">Push notifications are turned off.</p>}

      {masterOn && (
        <>
          <p className="nset__hint">
            <span className="nset__rowicon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </span>
            <span>
              On iPhone and iPad, push only works after{' '}
              <a href="/help/add-to-home-screen/">adding DRepTalk to the home screen</a>.
            </span>
          </p>

          {!thisDeviceConnected && (
            <div style={{ marginTop: '0.875rem' }}>
              <button type="button" className="btn btn-primary" disabled={connecting} onClick={() => void handleEnable()}>
                {connecting ? 'Connecting...' : 'Enable push notifications on this device'}
              </button>
            </div>
          )}

          {phase.status === 'blocked' && (
            <p style={{ margin: '0.5rem 0 0', color: 'var(--danger)', fontSize: '0.875rem' }}>
              Notifications are blocked for this site in your browser settings.
            </p>
          )}
          {phase.status === 'error' && (
            <p style={{ margin: '0.5rem 0 0', color: 'var(--danger)', fontSize: '0.875rem' }}>{phase.message}</p>
          )}

          {devices.map((device) => {
            const isThisDevice = deviceFingerprint !== null && device.fingerprint === deviceFingerprint;
            const state = testState[device.id];
            return (
              <div key={device.id}>
                <div className="nset__row">
                  <span className="nset__rowicon" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2" y="3" width="20" height="14" rx="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </span>
                  <div className="nset__rowtext">
                    <p className="nset__rowtitle">{isThisDevice ? 'This device' : 'Device'}</p>
                    <p className="nset__rowmeta">
                      Added on {new Date(device.createdAt).toLocaleDateString()}
                      {device.deliveredUntil > device.createdAt &&
                        ` · Last notified ${relativeTime(device.deliveredUntil, now)}`}
                    </p>
                  </div>
                  <div className="nset__rowactions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={state?.status === 'sending'}
                      onClick={() => void handleTest(device.id)}
                      style={{ padding: '0.3rem 0.75rem', fontSize: '0.8125rem' }}
                    >
                      Send test
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void handleRemove(device.id)}
                      style={{ padding: '0.3rem 0.75rem', fontSize: '0.8125rem' }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                {state?.status === 'scheduled' && (
                  <p style={{ margin: '0.4rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>
                    Test notification on its way: it arrives in about {state.delaySeconds} seconds, you can
                    lock your screen or switch away now.
                  </p>
                )}
                {state?.status === 'error' && (
                  <p style={{ margin: '0.4rem 0 0', fontSize: '0.8125rem', color: 'var(--danger)' }}>{state.message}</p>
                )}
              </div>
            );
          })}

          <NotificationPrefsMatrix prefs={prefState} onChange={(e, v) => void handlePrefToggle(e, v)} error={prefError} />
        </>
      )}
    </div>
  );
}
