// React island helper: the "Notify me about" event-type matrix shared by the
// push and Telegram settings cards on /notifications. Purely presentational
// and controlled: the parent (useChannelPrefs) owns pref state, optimistic
// updates and reverts, and passes the current prefs plus an onChange handler.
// Three deliberate groups: forum/governance activity (the original three
// types), the delegator-fanout types introduced for the delegator dashboard
// (DRep vote activity, DRep status, the user's own delegation), and the
// DRep-only types (stats digest, shareable rationale), shown only to
// accounts flagged as a DRep.
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';

const GENERAL_EVENT_TYPES: NotificationEventType[] = ['reply', 'mention', 'governance'];
const DELEGATION_EVENT_TYPES: NotificationEventType[] = ['drep_activity', 'drep_status', 'my_delegation'];
const DREP_EVENT_TYPES: NotificationEventType[] = ['drep_stats', 'rationale_ready'];

const EVENT_LABELS: Record<NotificationEventType, { label: string; hint: string }> = {
  reply: { label: 'Replies', hint: 'When someone replies in a thread you posted in' },
  mention: { label: 'Mentions', hint: 'When someone mentions you in a post' },
  governance: { label: 'Governance actions', hint: 'New actions and status changes' },
  drep_activity: { label: 'DRep votes', hint: 'When your DRep casts or changes a vote' },
  drep_status: { label: 'DRep status', hint: 'When your DRep becomes active or inactive' },
  my_delegation: { label: 'My delegation', hint: 'When your delegation changes' },
  drep_stats: { label: 'Voting power and delegators', hint: 'Epoch summary of your own DRep statistics' },
  rationale_ready: { label: 'Rationale ready to share', hint: 'When a vote you cast here is confirmed on chain and its rationale can be shared' },
};

function EventGroup({
  heading,
  eventTypes,
  prefs,
  onChange,
  disabled,
}: {
  heading: string;
  eventTypes: NotificationEventType[];
  prefs: Record<NotificationEventType, boolean>;
  onChange: (eventType: NotificationEventType, enabled: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="nset__matrixgroup">
      <h4 className="nset__matrixhead">{heading}</h4>
      {eventTypes.map((eventType) => (
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
    </div>
  );
}

export default function NotificationPrefsMatrix({
  prefs,
  onChange,
  error,
  disabled = false,
  showDrepStats = false,
}: {
  prefs: Record<NotificationEventType, boolean>;
  onChange: (eventType: NotificationEventType, enabled: boolean) => void;
  error?: string | null;
  disabled?: boolean;
  showDrepStats?: boolean;
}) {
  return (
    <div className="nset__matrix">
      <EventGroup
        heading="Notify me about"
        eventTypes={GENERAL_EVENT_TYPES}
        prefs={prefs}
        onChange={onChange}
        disabled={disabled}
      />
      <EventGroup
        heading="My delegation"
        eventTypes={DELEGATION_EVENT_TYPES}
        prefs={prefs}
        onChange={onChange}
        disabled={disabled}
      />
      {showDrepStats && (
        <EventGroup
          heading="As a DRep"
          eventTypes={DREP_EVENT_TYPES}
          prefs={prefs}
          onChange={onChange}
          disabled={disabled}
        />
      )}
      {error && <p style={{ margin: 0, color: 'var(--danger)', fontSize: '0.8125rem' }}>{error}</p>}
    </div>
  );
}
