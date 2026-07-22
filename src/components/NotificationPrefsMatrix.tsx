// React island helper: the "Notify me about" event-type matrix shared by the
// push and Telegram settings cards on /notifications. Purely presentational
// and controlled: the parent (useChannelPrefs) owns pref state, optimistic
// updates and reverts, and passes the current prefs plus an onChange handler.
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';

const EVENT_LABELS: Record<NotificationEventType, { label: string; hint: string }> = {
  reply: { label: 'Replies', hint: 'When someone replies in a thread you posted in' },
  mention: { label: 'Mentions', hint: 'When someone mentions you in a post' },
  governance: { label: 'Governance actions', hint: 'New actions and status changes' },
};

export default function NotificationPrefsMatrix({
  prefs,
  onChange,
  error,
  disabled = false,
}: {
  prefs: Record<NotificationEventType, boolean>;
  onChange: (eventType: NotificationEventType, enabled: boolean) => void;
  error?: string | null;
  disabled?: boolean;
}) {
  return (
    <div className="nset__matrix">
      <h4 className="nset__matrixhead">Notify me about</h4>
      {(Object.keys(EVENT_LABELS) as NotificationEventType[]).map((eventType) => (
        <label key={eventType} className="nset__opt">
          <input
            type="checkbox"
            checked={prefs[eventType]}
            disabled={disabled}
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
