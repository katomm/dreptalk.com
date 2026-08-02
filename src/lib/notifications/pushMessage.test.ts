import { describe, it, expect } from 'vitest';
import { formatNotification, formatSummary, type PendingLead } from './pushMessage.js';
import type { PendingCounts } from '../db/notificationChannels.js';

function counts(partial: Partial<PendingCounts>): PendingCounts {
  const base = {
    replies: 0,
    mentions: 0,
    governance: 0,
    drepActivity: 0,
    drepStatus: 0,
    myDelegation: 0,
    drepStats: 0,
    devices: 0,
  };
  const merged = { ...base, ...partial };
  const total =
    merged.replies +
    merged.mentions +
    merged.governance +
    merged.drepActivity +
    merged.drepStatus +
    merged.myDelegation +
    merged.drepStats +
    merged.devices;
  return { ...merged, total };
}

const lead: PendingLead = { text: 'New governance action: Parameter Change', href: '/t/param-change/' };

describe('formatNotification', () => {
  it('spells out a single event and links straight to it', () => {
    const msg = formatNotification(counts({ governance: 1 }), lead);
    expect(msg.body).toBe('New governance action: Parameter Change');
    expect(msg.path).toBe('/t/param-change/');
  });

  it('leads with the item and "(+N more)" for two or three, linking to the inbox', () => {
    const two = formatNotification(counts({ governance: 1, replies: 1 }), lead);
    expect(two.body).toBe('New governance action: Parameter Change (+1 more)');
    expect(two.path).toBe('/notifications/');

    const three = formatNotification(counts({ governance: 2, replies: 1 }), lead);
    expect(three.body).toBe('New governance action: Parameter Change (+2 more)');
  });

  it('falls back to the count summary at four or more', () => {
    const msg = formatNotification(counts({ replies: 2, governance: 2 }), lead);
    expect(msg.body).toBe('2 new replies, 2 governance updates');
    expect(msg.path).toBe('/notifications/');
  });

  it('uses the summary when no lead could be resolved, even for a single event', () => {
    const msg = formatNotification(counts({ governance: 1 }), null);
    expect(msg.body).toBe('1 governance update');
    expect(msg.path).toBe('/notifications/');
  });
});

describe('formatSummary', () => {
  it('joins non-zero categories with correct pluralization', () => {
    expect(formatSummary(counts({ replies: 1, mentions: 3 }))).toBe('1 new reply, 3 mentions');
    expect(formatSummary(counts({ drepActivity: 1, drepStatus: 2 }))).toBe(
      '1 DRep vote update, 2 DRep status changes',
    );
  });

  it('summarizes pending DRep stats digests', () => {
    expect(formatSummary(counts({ drepStats: 1 }))).toBe('1 DRep stats update');
    expect(formatSummary(counts({ drepStats: 2, replies: 1 }))).toBe('1 new reply, 2 DRep stats updates');
  });
});
