// Lightweight render assertion for NotificationsInbox: no testing-library in
// this repo, so the component is rendered to a static HTML string and asserted
// on directly (same approach as NotificationPrefsMatrix.test.tsx). Confirms the
// href === null title rendering (span, not anchor) and the per-kind lead.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NotificationsInbox from './NotificationsInbox.tsx';
import type { InboxItem } from '@/lib/notifications/inboxView.js';

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    kind: 'delegator_drep_voted',
    createdAt: 1_700_000_000_000,
    unread: false,
    actorName: null,
    actorHref: null,
    verb: null,
    title: 'Your DRep voted on Reduce fees',
    href: '/t/reduce-fees/',
    pill: null,
    ...overrides,
  };
}

describe('NotificationsInbox', () => {
  it('renders the title as plain text (no anchor) when href is null', () => {
    const html = renderToStaticMarkup(
      <NotificationsInbox items={[item({ href: null, title: 'Your DRep voted on a governance action' })]} now={1_700_000_100_000} />,
    );
    expect(html).toContain('Your DRep voted on a governance action');
    expect(html).not.toMatch(/<a[^>]*>Your DRep voted on a governance action<\/a>/);
  });

  it('renders the title as a link when href is non-null', () => {
    const html = renderToStaticMarkup(
      <NotificationsInbox items={[item({ href: '/t/reduce-fees/', title: 'Your DRep voted on Reduce fees' })]} now={1_700_000_100_000} />,
    );
    expect(html).toContain('href="/t/reduce-fees/"');
    expect(html).toMatch(/<a[^>]*href="\/t\/reduce-fees\/"[^>]*>Your DRep voted on Reduce fees<\/a>/);
  });
  it('leads a Governance Review announcement with its own label', () => {
    const html = renderToStaticMarkup(
      <NotificationsInbox
        items={[item({ kind: 'review_published', title: 'Edition 43: The budget returns', href: '/governance-review/epochs-656-658/' })]}
        now={1_700_000_100_000}
      />,
    );
    expect(html).toContain('New Governance Review');
    expect(html).toContain('Edition 43: The budget returns');
    expect(html).not.toContain('Governance action is now');
  });

  it('leads a shareable rationale with its own label, not a status change', () => {
    const html = renderToStaticMarkup(
      <NotificationsInbox items={[item({ kind: 'rationale_ready', title: 'Your rationale on X is ready to share' })]} now={1_700_000_100_000} />,
    );
    expect(html).toContain('Your vote');
    expect(html).not.toContain('Governance action is now');
  });
});
