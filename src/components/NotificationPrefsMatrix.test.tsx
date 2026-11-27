// Lightweight render assertion for NotificationPrefsMatrix: the component is
// rendered to a static HTML string and asserted on directly.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NotificationPrefsMatrix from './NotificationPrefsMatrix.tsx';
import { NOTIFICATION_EVENT_TYPES } from '@/lib/db/notificationChannels.js';
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';

const allEnabled = Object.fromEntries(NOTIFICATION_EVENT_TYPES.map((t) => [t, true])) as Record<
  NotificationEventType,
  boolean
>;

// One checkbox per event type the matrix offers.
const toggles = (html: string) => html.match(/type="checkbox"/g)?.length ?? 0;
const render = (props: { showDrepStats?: boolean; showDrepGroups?: boolean }) =>
  renderToStaticMarkup(<NotificationPrefsMatrix prefs={allEnabled} onChange={() => {}} {...props} />);

describe('NotificationPrefsMatrix', () => {
  it('offers the DRep toggles only with showDrepStats, and the groups toggle only where groups exist', () => {
    // Deltas, so a new general notification type does not break this gating test.
    const base = toggles(render({}));
    expect(toggles(render({ showDrepGroups: true }))).toBe(base);
    const withoutGroups = render({ showDrepStats: true });
    const withGroups = render({ showDrepStats: true, showDrepGroups: true });
    expect(toggles(withoutGroups) - base).toBe(2);
    expect(toggles(withGroups) - toggles(withoutGroups)).toBe(1);
    // The toggle that goes missing is the groups one.
    expect(withoutGroups).not.toContain('DRep groups');
    expect(withGroups).toContain('DRep groups');
  });
});
