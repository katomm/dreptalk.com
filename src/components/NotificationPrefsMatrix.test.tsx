// Lightweight render assertion for NotificationPrefsMatrix: no
// testing-library in this repo, so the component is rendered to a static
// HTML string and asserted on directly. Confirms the two-group layout (the
// original three event types plus the delegator-fanout "My delegation"
// group) survives Task 6's widened NOTIFICATION_EVENT_TYPES union.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NotificationPrefsMatrix from './NotificationPrefsMatrix.tsx';
import { NOTIFICATION_EVENT_TYPES } from '@/lib/db/notificationChannels.js';
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';

const allEnabled = Object.fromEntries(NOTIFICATION_EVENT_TYPES.map((t) => [t, true])) as Record<
  NotificationEventType,
  boolean
>;

describe('NotificationPrefsMatrix', () => {
  it('renders both group headings and all six event options', () => {
    const html = renderToStaticMarkup(
      <NotificationPrefsMatrix prefs={allEnabled} onChange={() => {}} />,
    );

    expect(html).toContain('Notify me about');
    expect(html).toContain('My delegation');

    expect(html).toContain('Replies');
    expect(html).toContain('Mentions');
    expect(html).toContain('Governance actions');
    expect(html).toContain('DRep votes');
    expect(html).toContain('DRep status');
  });
});
