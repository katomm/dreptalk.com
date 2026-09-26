// Lightweight render assertion for NotificationPrefsMatrix: no
// testing-library in this repo, so the component is rendered to a static
// HTML string and asserted on directly. Confirms the DRep-only group renders
// only when showDrepStats is set.
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
  it('hides the As a DRep group by default', () => {
    const html = renderToStaticMarkup(
      <NotificationPrefsMatrix prefs={allEnabled} onChange={() => {}} />,
    );
    expect(html).not.toContain('As a DRep');
    expect(html).not.toContain('Voting power and delegators');
    expect(html).not.toContain('Rationale ready to share');
  });

  it('shows the As a DRep group when showDrepStats is set', () => {
    const html = renderToStaticMarkup(
      <NotificationPrefsMatrix prefs={allEnabled} onChange={() => {}} showDrepStats />,
    );
    expect(html).toContain('As a DRep');
    expect(html).toContain('Voting power and delegators');
    expect(html).toContain('Epoch summary of your own DRep statistics');
    expect(html).toContain('Rationale ready to share');
  });
});
