import { describe, it, expect } from 'vitest';
import { nextCronRunMs, CRON_GOVERNANCE, CRON_VOTE_SYNC, CRON_DREP_SYNC } from './freshness.js';

// 2026-06-12 10:07:30 UTC
const NOW = Date.UTC(2026, 5, 12, 10, 7, 30);

describe('nextCronRunMs', () => {
  it('finds the next quarter hour for the governance cron', () => {
    expect(nextCronRunMs(CRON_GOVERNANCE, NOW)).toBe(Date.UTC(2026, 5, 12, 10, 15));
  });

  it('finds the next 20-minute boundary for the vote cron', () => {
    expect(nextCronRunMs(CRON_VOTE_SYNC, NOW)).toBe(Date.UTC(2026, 5, 12, 10, 20));
  });

  it('finds the next 6-hour boundary for the drep cron', () => {
    expect(nextCronRunMs(CRON_DREP_SYNC, NOW)).toBe(Date.UTC(2026, 5, 12, 12, 0));
  });

  it('is strictly after now even when now is exactly on a boundary', () => {
    const onBoundary = Date.UTC(2026, 5, 12, 12, 0);
    expect(nextCronRunMs(CRON_DREP_SYNC, onBoundary)).toBe(Date.UTC(2026, 5, 12, 18, 0));
  });

  it('rolls over to the next day', () => {
    const lateEvening = Date.UTC(2026, 5, 12, 23, 50);
    expect(nextCronRunMs(CRON_DREP_SYNC, lateEvening)).toBe(Date.UTC(2026, 5, 13, 0, 0));
  });

  it('returns null for unsupported expressions', () => {
    expect(nextCronRunMs('0 0 1 * *', NOW)).toBeNull();
    expect(nextCronRunMs('1,5 * * * *', NOW)).toBeNull();
  });
});
