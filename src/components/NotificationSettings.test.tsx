// Server render assertion for NotificationSettings: no testing-library in this
// repo, so the component is rendered to a static HTML string (the same way the
// Astro page server-renders the island) and asserted on directly. Guards the
// hydration contract: the server has no navigator.serviceWorker, so the markup
// it sends must be the push card a supporting browser renders on its first
// pass, never the "not supported" message.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NotificationSettings from './NotificationSettings.tsx';
import { NOTIFICATION_EVENT_TYPES } from '@/lib/db/notificationChannels.js';
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';

const allEnabled = Object.fromEntries(NOTIFICATION_EVENT_TYPES.map((t) => [t, true])) as Record<
  NotificationEventType,
  boolean
>;

describe('NotificationSettings server render', () => {
  it('renders the push card, not the unsupported message, so hydration matches a supporting browser', () => {
    const html = renderToStaticMarkup(<NotificationSettings channels={[]} prefs={allEnabled} vapidPublicKey="BPUBLICKEY" />);
    expect(html).toContain('Enable push notifications on this device');
    expect(html).not.toContain('Push is not supported in this browser');
  });

  it('still says push is not configured when the deployment has no VAPID key', () => {
    const html = renderToStaticMarkup(<NotificationSettings channels={[]} prefs={allEnabled} vapidPublicKey="" />);
    expect(html).toContain('Push notifications are not configured on this deployment yet.');
  });
});
