// React island helper: the "Notify me about" event-type matrix shared by the
// push and Telegram settings cards on /notifications. Presentational and
// controlled: the parent owns pref state, optimistic updates and reverts, and
// passes the current prefs plus an onChange handler. setAllPrefs (exported) is
// what the parents' master toggle uses to flip all three at once.
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';

const EVENT_LABELS: Record<NotificationEventType, { label: string; hint: string }> = {
  reply: { label: 'Replies', hint: 'When someone replies in a thread you posted in' },
  mention: { label: 'Mentions', hint: 'When someone mentions you in a post' },
  governance: { label: 'Governance actions', hint: 'New actions and status changes' },
};

/**
 * Flips all three event prefs for a channel in parallel. Used by the master
 * toggle in each settings card. Resolves true only when every POST succeeded,
 * so the caller can revert its optimistic state on any failure.
 */
export async function setAllPrefs(channel: 'webpush' | 'telegram', enabled: boolean): Promise<boolean> {
  const results = await Promise.all(
    (Object.keys(EVENT_LABELS) as NotificationEventType[]).map((eventType) =>
      fetchWithTimeout('/api/notifications/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, eventType, enabled }),
      })
        .then((r) => r.ok)
        .catch(() => false),
    ),
  );
  return results.every(Boolean);
}

export default function NotificationPrefsMatrix({
  prefs,
  onChange,
  error,
}: {
  prefs: Record<NotificationEventType, boolean>;
  onChange: (eventType: NotificationEventType, enabled: boolean) => void;
  error?: string | null;
}) {
  return (
    <div className="nset__matrix">
      <h4 className="nset__matrixhead">Notify me about</h4>
      {(Object.keys(EVENT_LABELS) as NotificationEventType[]).map((eventType) => (
        <label key={eventType} className="nset__opt">
          <input
            type="checkbox"
            checked={prefs[eventType]}
            onChange={(e) => onChange(eventType, e.target.checked)}
          />
          <div>
            <div className="nset__optlabel">{EVENT_LABELS[eventType].label}</div>
            <p className="nset__optdesc">{EVENT_LABELS[eventType].hint}</p>
          </div>
        </label>
      ))}
      {error && <p style={{ margin: 0, color: 'var(--danger)', fontSize: '0.8125rem' }}>{error}</p>}
    </div>
  );
}
