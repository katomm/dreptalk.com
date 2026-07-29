// The notifications inbox: filter sidebar (desktop) / filter chips (mobile)
// plus the time-grouped list. All data arrives server-rendered via props; this
// island only filters, groups and expands client-side (see inboxView.ts for
// the pure logic). Styling lives in global.css under .ninbox__*.
import { useState } from 'react';
import {
  countItems,
  filterItems,
  groupItems,
  relativeTime,
  GROUP_VISIBLE,
  type InboxFilter,
  type InboxItem,
} from '@/lib/notifications/inboxView.js';

const TONE_COLORS: Record<string, string> = {
  active: 'var(--accent)',
  positive: 'var(--c-pos)',
  negative: 'var(--c-neg)',
  neutral: 'var(--muted)',
};

const FILTERS: { key: InboxFilter; label: string; countKey: keyof ReturnType<typeof countItems> }[] = [
  { key: 'all', label: 'All notifications', countKey: 'all' },
  { key: 'unread', label: 'Unread', countKey: 'unread' },
  { key: 'mentions', label: 'Mentions', countKey: 'mentions' },
  { key: 'governance', label: 'Governance actions', countKey: 'governance' },
  { key: 'discussions', label: 'Discussions', countKey: 'discussions' },
];

function KindIcon({ kind }: { kind: InboxItem['kind'] }) {
  // aria-hidden sits directly on each svg (not in the spread) so tooling can
  // see the icons are decorative; the row text carries the meaning.
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (kind === 'reply') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    );
  }
  if (kind === 'mention') {
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
      </svg>
    );
  }
  if (kind === 'device_paired') {
    // Security notice about a paired device: a phone.
    return (
      <svg {...common} aria-hidden="true">
        <rect x="7" y="2" width="10" height="20" rx="2" />
        <path d="M11 18h2" />
      </svg>
    );
  }
  if (kind === 'delegation_changed') {
    // Delegation moved: a pair of swap arrows.
    return (
      <svg {...common} aria-hidden="true">
        <path d="M17 3 21 7 17 11" />
        <path d="M21 7H9" />
        <path d="M7 21 3 17 7 13" />
        <path d="M3 17h12" />
      </svg>
    );
  }
  // Governance: a simple landmark.
  return (
    <svg {...common} aria-hidden="true">
      <path d="M3 21h18" />
      <path d="M5 21V10m4 11V10m6 11V10m4 11V10" />
      <path d="M2 10l10-6 10 6" />
    </svg>
  );
}

function Row({ item, now }: { item: InboxItem; now: number }) {
  return (
    <li className={item.unread ? 'ninbox__row ninbox__row--unread' : 'ninbox__row'}>
      {item.unread && <span className="ninbox__dot" role="status" aria-label="Unread"></span>}
      <span className="ninbox__icon">
        <KindIcon kind={item.kind} />
      </span>
      <span className="ninbox__body">
        <span className="ninbox__lead">
          {item.kind === 'reply' || item.kind === 'mention' ? (
            <>
              {item.actorHref ? (
                <a href={item.actorHref} className="ninbox__actor">
                  {item.actorName}
                </a>
              ) : (
                <span className="ninbox__actor">{item.actorName}</span>
              )}{' '}
              {item.verb}
            </>
          ) : item.kind === 'device_paired' ? (
            'Security'
          ) : item.kind === 'delegation_changed' ? (
            'Delegation'
          ) : item.kind === 'gov_created' ? (
            'New governance action'
          ) : (
            'Governance action is now'
          )}
          {item.pill && (
            <span
              className="ninbox__pill"
              style={
                item.pill.outline
                  ? { color: TONE_COLORS[item.pill.tone], borderColor: 'currentcolor', background: 'transparent' }
                  : {
                      color: TONE_COLORS[item.pill.tone],
                      background: `color-mix(in srgb, ${TONE_COLORS[item.pill.tone]} 13%, transparent)`,
                      borderColor: 'transparent',
                    }
              }
            >
              {item.pill.label}
            </span>
          )}
        </span>
        <a href={item.href} className="ninbox__title">
          {item.title}
        </a>
      </span>
      <span className="ninbox__time">{relativeTime(item.createdAt, now)}</span>
    </li>
  );
}

export default function NotificationsInbox({ items, now }: { items: InboxItem[]; now: number }) {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const counts = countItems(items);
  const groups = groupItems(filterItems(items, filter), now);

  return (
    <div className="ninbox">
      <nav className="ninbox__filters" aria-label="Notification filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={filter === f.key ? 'ninbox__filter ninbox__filter--active' : 'ninbox__filter'}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            <span>{f.label}</span>
            <span className="ninbox__count">{counts[f.countKey]}</span>
          </button>
        ))}
      </nav>

      <div className="ninbox__main">
        {groups.length === 0 ? (
          <p className="ninbox__empty">
            Nothing here yet. Replies, mentions and governance events will show up in this inbox.
          </p>
        ) : (
          groups.map((group) => {
            const isOpen = expanded[`${filter}:${group.key}`] === true;
            const visible = isOpen ? group.items : group.items.slice(0, GROUP_VISIBLE);
            const hidden = group.items.length - visible.length;
            return (
              <section key={group.key} className="ninbox__group">
                <h2 className="ninbox__group-label">{group.label}</h2>
                <ul className="ninbox__list">
                  {visible.map((item) => (
                    <Row key={`${item.kind}-${item.href}-${item.createdAt}`} item={item} now={now} />
                  ))}
                </ul>
                {hidden > 0 && (
                  <button
                    type="button"
                    className="ninbox__more"
                    onClick={() => setExpanded((prev) => ({ ...prev, [`${filter}:${group.key}`]: true }))}
                  >
                    View {hidden} more
                  </button>
                )}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
