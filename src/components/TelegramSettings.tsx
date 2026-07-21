// React island: Telegram settings inside the notification-settings section on
// /notifications. Connect flow: request a one-time deep link, open it in a new
// tab, then poll the channels endpoint until the webhook has stored the new
// telegram channel (or the poll window closes). Connected chats get a test
// send, a remove button, and their own event-type matrix.
import { useEffect, useRef, useState } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';
import NotificationPrefsMatrix from './NotificationPrefsMatrix.tsx';
import type { NotificationDevice } from './NotificationSettings.tsx';

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 40; // 2 minutes

type ConnectPhase = { status: 'idle' } | { status: 'waiting' } | { status: 'error'; message: string };

export default function TelegramSettings({
  channels,
  prefs,
  botUsername,
}: {
  channels: NotificationDevice[];
  prefs: Record<NotificationEventType, boolean>;
  botUsername: string;
}) {
  const [connected, setConnected] = useState<NotificationDevice[]>(channels);
  const [phase, setPhase] = useState<ConnectPhase>({ status: 'idle' });
  // Fallback link shown when the browser blocked the popup (Safari drops user
  // activation across the await before window.open). Cleared once the user
  // finishes the link or presses connect again.
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [testState, setTestState] = useState<
    Record<string, { status: 'sending' } | { status: 'done' } | { status: 'error'; message: string }>
  >({});
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposed = useRef(false);

  useEffect(() => () => {
    disposed.current = true;
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  async function fetchTelegramChannels(): Promise<NotificationDevice[] | null> {
    try {
      const res = await fetchWithTimeout('/api/notifications/channels');
      if (!res.ok) return null;
      const data = (await res.json()) as { channels: { id: string; channel: string; createdAt: number }[] };
      return data.channels.filter((c) => c.channel === 'telegram').map((c) => ({ id: c.id, createdAt: c.createdAt }));
    } catch {
      return null;
    }
  }

  function pollForLink(attempt: number, knownIds: Set<string>) {
    if (attempt >= POLL_MAX_ATTEMPTS) {
      // Give up quietly; also drop the fallback link so it does not suggest a
      // still-active connect attempt.
      setPhase({ status: 'idle' });
      setConnectUrl(null);
      return;
    }
    pollTimer.current = setTimeout(async () => {
      const fresh = await fetchTelegramChannels();
      // The component may have unmounted while the fetch was in flight; the
      // unmount cleanup only clears the pending timer, not an in-flight
      // request, so bail out here instead of re-arming or touching state.
      if (disposed.current) return;
      const added = fresh?.find((c) => !knownIds.has(c.id));
      if (fresh && added) {
        setConnected(fresh);
        setPhase({ status: 'idle' });
        setConnectUrl(null);
        return;
      }
      pollForLink(attempt + 1, knownIds);
    }, POLL_INTERVAL_MS);
  }

  async function handleConnect() {
    setPhase({ status: 'waiting' });
    setConnectUrl(null);
    try {
      const res = await fetchWithTimeout('/api/notifications/telegram-link', { method: 'POST' });
      if (!res.ok) {
        setPhase({ status: 'error', message: 'Could not create a Telegram link. Please try again.' });
        return;
      }
      const { url } = (await res.json()) as { url: string };
      // window.open runs after an await, so browsers (notably Safari) may
      // have already dropped user activation and block the popup. Fall back
      // to a visible link instead of erroring out, and poll either way since
      // the user can still tap the fallback link manually.
      const popup = window.open(url, '_blank', 'noopener');
      if (!popup) setConnectUrl(url);
      pollForLink(0, new Set(connected.map((c) => c.id)));
    } catch {
      setPhase({ status: 'error', message: 'Could not create a Telegram link. Please try again.' });
    }
  }

  async function handleRemove(id: string) {
    const prev = connected;
    setConnected((cur) => cur.filter((c) => c.id !== id));
    try {
      const res = await fetchWithTimeout('/api/notifications/channels', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) setConnected(prev);
    } catch {
      setConnected(prev);
    }
  }

  async function handleTest(id: string) {
    setTestState((prevState) => ({ ...prevState, [id]: { status: 'sending' } }));
    try {
      const res = await fetchWithTimeout('/api/notifications/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.status === 429) {
        setTestState((prevState) => ({ ...prevState, [id]: { status: 'error', message: 'Too many test notifications. Please wait a bit.' } }));
        return;
      }
      if (!res.ok) {
        setTestState((prevState) => ({ ...prevState, [id]: { status: 'error', message: 'Could not send a test. Please try again.' } }));
        return;
      }
      setTestState((prevState) => ({ ...prevState, [id]: { status: 'done' } }));
    } catch {
      setTestState((prevState) => ({ ...prevState, [id]: { status: 'error', message: 'Could not send a test. Please try again.' } }));
    }
  }

  return (
    <div style={{ maxWidth: '32rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={phase.status === 'waiting'}
          onClick={() => void handleConnect()}
        >
          {phase.status === 'waiting' ? 'Waiting for Telegram...' : connected.length > 0 ? 'Connect another Telegram chat' : 'Connect Telegram'}
        </button>
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>
          Opens a chat with @{botUsername}. Press Start there to connect this account.
        </p>
        {connectUrl && (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem' }}>
            <a href={connectUrl} target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>
              Open Telegram to finish connecting
            </a>
          </p>
        )}
      </div>

      {phase.status === 'error' && (
        <p style={{ margin: 0, color: 'var(--danger)', fontSize: '0.875rem' }}>{phase.message}</p>
      )}

      {connected.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {connected.map((chat) => (
            <div
              key={chat.id}
              style={{
                padding: '0.5rem 0.75rem',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                fontSize: '0.875rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                <span>Telegram connected {new Date(chat.createdAt).toLocaleDateString()}</span>
                <span style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={testState[chat.id]?.status === 'sending'}
                    onClick={() => void handleTest(chat.id)}
                    style={{ padding: '0.3rem 0.75rem', fontSize: '0.8125rem' }}
                  >
                    Send test
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void handleRemove(chat.id)}
                    style={{ padding: '0.3rem 0.75rem', fontSize: '0.8125rem' }}
                  >
                    Remove
                  </button>
                </span>
              </div>
              {testState[chat.id]?.status === 'done' && (
                <p style={{ margin: '0.4rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>
                  Test message sent. Check your Telegram.
                </p>
              )}
              {(() => {
                const state = testState[chat.id];
                if (state?.status !== 'error') return null;
                return (
                  <p style={{ margin: '0.4rem 0 0', fontSize: '0.8125rem', color: 'var(--danger)' }}>{state.message}</p>
                );
              })()}
            </div>
          ))}
        </div>
      )}

      {connected.length > 0 && <NotificationPrefsMatrix channel="telegram" prefs={prefs} />}
    </div>
  );
}
