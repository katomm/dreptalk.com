// React island: the "Notify me about" event-type matrix shared by the push
// and Telegram settings blocks on /notifications. Optimistically toggles a
// checkbox, posts the change, and reverts on failure.
import { useState } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';

const EVENT_LABELS: Record<NotificationEventType, { label: string; hint: string }> = {
  reply: { label: 'Replies', hint: 'someone replies in a thread you posted in' },
  mention: { label: 'Mentions', hint: 'someone mentions you in a post' },
  governance: { label: 'Governance actions', hint: 'new actions and status changes' },
};

export default function NotificationPrefsMatrix({
  channel,
  prefs,
}: {
  channel: 'webpush' | 'telegram';
  prefs: Record<NotificationEventType, boolean>;
}) {
  const [prefState, setPrefState] = useState<Record<NotificationEventType, boolean>>(prefs);
  const [prefError, setPrefError] = useState<string | null>(null);

  async function handlePrefToggle(eventType: NotificationEventType, enabled: boolean) {
    setPrefError(null);
    const prevPrefs = prefState;
    setPrefState((prev) => ({ ...prev, [eventType]: enabled }));
    try {
      const res = await fetchWithTimeout('/api/notifications/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, eventType, enabled }),
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

  return (
    <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <h3 style={{ margin: 0, fontSize: '0.9375rem' }}>Notify me about</h3>
      {(Object.keys(EVENT_LABELS) as NotificationEventType[]).map((eventType) => (
        <label key={eventType} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.875rem' }}>
          <input
            type="checkbox"
            checked={prefState[eventType]}
            onChange={(e) => void handlePrefToggle(eventType, e.target.checked)}
          />
          <span>
            {EVENT_LABELS[eventType].label}{' '}
            <span style={{ color: 'var(--muted)' }}>({EVENT_LABELS[eventType].hint})</span>
          </span>
        </label>
      ))}
      {prefError && <p style={{ margin: 0, color: 'var(--danger)', fontSize: '0.8125rem' }}>{prefError}</p>}
    </div>
  );
}
