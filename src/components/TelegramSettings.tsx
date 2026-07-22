// React island: the Telegram notifications card inside the settings section on
// /notifications. Connect flow: request a one-time deep link, open it in a new
// tab, then poll the channels endpoint until the webhook has stored the new
// telegram channel (or the poll window closes). A master toggle turns all event
// prefs on or off; connected chats get a test send, a remove button, and the
// shared event-type matrix.
import { useEffect, useRef, useState } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { relativeTime } from '@/lib/notifications/inboxView.js';
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';
import NotificationPrefsMatrix, { setAllPrefs } from './NotificationPrefsMatrix.tsx';
import type { ClientChannelProps } from './NotificationSettings.tsx';

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 40; // 2 minutes

type ConnectPhase = { status: 'idle' } | { status: 'waiting' } | { status: 'error'; message: string };

export default function TelegramSettings({
  channels,
  prefs,
  botUsername,
}: {
  channels: ClientChannelProps[];
  prefs: Record<NotificationEventType, boolean>;
  botUsername: string;
}) {
  const [connected, setConnected] = useState<ClientChannelProps[]>(channels);
  const [phase, setPhase] = useState<ConnectPhase>({ status: 'idle' });
  const [prefState, setPrefState] = useState<Record<NotificationEventType, boolean>>(prefs);
  const [prefError, setPrefError] = useState<string | null>(null);
  // True while a prefs request (master or single toggle) is in flight. Serializes
  // pref updates so the snapshot-and-revert in handleMasterToggle/handlePrefToggle
  // can never discard a change from an overlapping request.
  const [prefsBusy, setPrefsBusy] = useState(false);
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

  async function fetchTelegramChannels(): Promise<ClientChannelProps[] | null> {
    try {
      const res = await fetchWithTimeout('/api/notifications/channels');
      if (!res.ok) return null;
      const data = (await res.json()) as { channels: (ClientChannelProps & { channel: string })[] };
      return data.channels
        .filter((c) => c.channel === 'telegram')
        .map((c) => ({ id: c.id, createdAt: c.createdAt, deliveredUntil: c.deliveredUntil, label: c.label, fingerprint: c.fingerprint }));
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

  async function handleMasterToggle() {
    if (prefsBusy) return;
    const next = !masterOn;
    const prev = prefState;
    setPrefError(null);
    setPrefsBusy(true);
    setPrefState({ reply: next, mention: next, governance: next });
    try {
      const ok = await setAllPrefs('telegram', next);
      if (!ok) {
        setPrefState(prev);
        setPrefError('Could not save that setting. Please try again.');
      }
    } finally {
      setPrefsBusy(false);
    }
  }

  async function handlePrefToggle(eventType: NotificationEventType, enabled: boolean) {
    if (prefsBusy) return;
    setPrefError(null);
    const prev = prefState;
    setPrefsBusy(true);
    setPrefState((p) => ({ ...p, [eventType]: enabled }));
    try {
      const res = await fetchWithTimeout('/api/notifications/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'telegram', eventType, enabled }),
      });
      if (!res.ok) {
        setPrefState(prev);
        setPrefError('Could not save that setting. Please try again.');
      }
    } catch {
      setPrefState(prev);
      setPrefError('Could not save that setting. Please try again.');
    } finally {
      setPrefsBusy(false);
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

  const masterOn = Object.values(prefState).some(Boolean);
  const now = Date.now();

  const planeIcon = (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );

  return (
    <div className="nset__card">
      <div className="nset__head">
        <span className="nset__icon" aria-hidden="true">
          {planeIcon}
        </span>
        <div className="nset__headtext">
          <h3 className="nset__title">Telegram notifications</h3>
          <p className="nset__cardsub">Get notified in Telegram via @{botUsername}.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={masterOn}
          aria-disabled={prefsBusy}
          aria-label="Telegram notifications"
          className="nset__switch"
          onClick={() => {
            if (!prefsBusy) void handleMasterToggle();
          }}
        />
      </div>

      {!masterOn && <p className="nset__off">Telegram notifications are turned off.</p>}

      {masterOn && (
        <>
          <div style={{ marginTop: '0.875rem' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={phase.status === 'waiting'}
              onClick={() => void handleConnect()}
            >
              {phase.status === 'waiting'
                ? 'Waiting for Telegram...'
                : connected.length > 0
                  ? 'Connect another Telegram chat'
                  : 'Connect Telegram'}
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
            <p style={{ margin: '0.5rem 0 0', color: 'var(--danger)', fontSize: '0.875rem' }}>{phase.message}</p>
          )}

          {connected.map((chat) => {
            const state = testState[chat.id];
            return (
              <div key={chat.id}>
                <div className="nset__row">
                  <span className="nset__rowicon" aria-hidden="true">
                    {planeIcon}
                  </span>
                  <div className="nset__rowtext">
                    <p className="nset__rowtitle">{chat.label ?? 'Connected chat'}</p>
                    <p className="nset__rowmeta">
                      Connected on {new Date(chat.createdAt).toLocaleDateString()}
                      {chat.deliveredUntil > chat.createdAt &&
                        ` · Last notified ${relativeTime(chat.deliveredUntil, now)}`}
                    </p>
                  </div>
                  <div className="nset__rowactions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={state?.status === 'sending'}
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
                  </div>
                </div>
                {state?.status === 'done' && (
                  <p style={{ margin: '0.4rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>
                    Test message sent. Check your Telegram.
                  </p>
                )}
                {state?.status === 'error' && (
                  <p style={{ margin: '0.4rem 0 0', fontSize: '0.8125rem', color: 'var(--danger)' }}>{state.message}</p>
                )}
              </div>
            );
          })}

          {connected.length > 0 && (
            <NotificationPrefsMatrix
              prefs={prefState}
              onChange={(e, v) => void handlePrefToggle(e, v)}
              error={prefError}
              disabled={prefsBusy}
            />
          )}
        </>
      )}
    </div>
  );
}
