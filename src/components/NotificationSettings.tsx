// React island: push notification settings on the account settings page.
// Two pieces: a connect flow that registers the service worker, asks for
// permission, and subscribes this device, and (once at least one device is
// connected) an event-type matrix for the webpush channel. Visible to every
// signed-in writer; the page passes an empty vapidPublicKey when push is not
// configured on this deployment yet.
import { useState } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { fromBase64Url } from '@/lib/crypto/base64url.js';
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';

export interface NotificationDevice {
  id: string;
  createdAt: number;
}

export interface NotificationSettingsProps {
  channels: NotificationDevice[];
  prefs: Record<NotificationEventType, boolean>;
  vapidPublicKey: string;
}

const EVENT_LABELS: Record<NotificationEventType, string> = {
  reply: 'Replies',
  mention: 'Mentions',
  governance: 'Governance',
};

type ConnectPhase =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'blocked' }
  | { status: 'error'; message: string };

function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

export default function NotificationSettings({ channels, prefs, vapidPublicKey }: NotificationSettingsProps) {
  const [devices, setDevices] = useState<NotificationDevice[]>(channels);
  const [phase, setPhase] = useState<ConnectPhase>({ status: 'idle' });
  const [prefState, setPrefState] = useState<Record<NotificationEventType, boolean>>(prefs);
  const [prefError, setPrefError] = useState<string | null>(null);

  if (!vapidPublicKey) {
    return (
      <p style={{ margin: 0, color: 'var(--muted)', maxWidth: '32rem' }}>
        Push notifications are not configured on this deployment yet.
      </p>
    );
  }

  const supported = pushSupported();
  if (!supported) {
    return (
      <p style={{ margin: 0, color: 'var(--muted)', maxWidth: '32rem' }}>
        Push is not supported in this browser. On iPhone and iPad it only works after
        adding DRepTalk to the home screen.
      </p>
    );
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

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(vapidPublicKey),
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
      setDevices((prev) => [...prev, { id, createdAt: Date.now() }]);
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

  async function handlePrefToggle(eventType: NotificationEventType, enabled: boolean) {
    setPrefError(null);
    const prevPrefs = prefState;
    setPrefState((prev) => ({ ...prev, [eventType]: enabled }));
    try {
      const res = await fetchWithTimeout('/api/notifications/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'webpush', eventType, enabled }),
      });
      if (!res.ok) {
        setPrefState(prevPrefs);
        setPrefError('Could not save that setting. Please try again.');
      }
    } catch {
      setPrefState(prevPrefs);
      setPrefError('Could not save that setting. Please try again.');
    }
  }

  const connecting = phase.status === 'connecting';

  return (
    <div style={{ maxWidth: '32rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div>
        <button type="button" className="btn btn-primary" disabled={connecting} onClick={() => void handleEnable()}>
          {connecting ? 'Connecting...' : 'Enable push notifications on this device'}
        </button>
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>
          On iPhone and iPad, push only works after adding DRepTalk to the home screen.
        </p>
      </div>

      {phase.status === 'blocked' && (
        <p style={{ margin: 0, color: 'var(--danger)', fontSize: '0.875rem' }}>
          Notifications are blocked for this site in your browser settings.
        </p>
      )}
      {phase.status === 'error' && (
        <p style={{ margin: 0, color: 'var(--danger)', fontSize: '0.875rem' }}>{phase.message}</p>
      )}

      {devices.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {devices.map((device) => (
            <div
              key={device.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.75rem',
                padding: '0.5rem 0.75rem',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                fontSize: '0.875rem',
              }}
            >
              <span>Device added {new Date(device.createdAt).toLocaleDateString()}</span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleRemove(device.id)}
                style={{ padding: '0.3rem 0.75rem', fontSize: '0.8125rem' }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {devices.length > 0 && (
        <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <h3 style={{ margin: 0, fontSize: '0.9375rem' }}>Notify me about</h3>
          {(Object.keys(EVENT_LABELS) as NotificationEventType[]).map((eventType) => (
            <label
              key={eventType}
              style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.875rem' }}
            >
              <input
                type="checkbox"
                checked={prefState[eventType]}
                onChange={(e) => void handlePrefToggle(eventType, e.target.checked)}
              />
              <span>{EVENT_LABELS[eventType]}</span>
            </label>
          ))}
          {prefError && (
            <p style={{ margin: 0, color: 'var(--danger)', fontSize: '0.8125rem' }}>{prefError}</p>
          )}
        </div>
      )}
    </div>
  );
}
