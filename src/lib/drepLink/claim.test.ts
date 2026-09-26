import { describe, it, expect } from 'vitest';
import { checkClaimPolicy, nextNewHandleAt } from './claim.js';
import { COOLDOWN_SEC } from './handle.js';
import type { HandleRow } from '../db/drepHandles.js';

const NOW = 1_800_000_000;
const D = 'drep1x';
const r = (handle: string, o: Partial<HandleRow> = {}): HandleRow => ({
  handle, drepId: D, source: 'seed', isPrimary: true, releasedAt: null, createdAt: 0, ...o,
});

describe('checkClaimPolicy', () => {
  it('allows the first own change away from a seeded handle', () => {
    expect(checkClaimPolicy({ handle: 'new-name', drepId: D, rows: [r('old')], now: NOW })).toEqual({ ok: true });
  });
  it('rejects the current handle as unchanged', () => {
    expect(checkClaimPolicy({ handle: 'old', drepId: D, rows: [r('old')], now: NOW })).toEqual({ ok: false, error: 'unchanged' });
  });
  it('enforces 90 days after a claimed or manual handle', () => {
    const rows = [r('mine', { source: 'claim', createdAt: NOW - 10 })];
    expect(checkClaimPolicy({ handle: 'next', drepId: D, rows, now: NOW })).toEqual({
      ok: false, error: 'cooldown', until: NOW - 10 + COOLDOWN_SEC,
    });
    const later = [r('mine', { source: 'manual', createdAt: NOW - COOLDOWN_SEC })];
    expect(checkClaimPolicy({ handle: 'next', drepId: D, rows: later, now: NOW })).toEqual({ ok: true });
  });
  it('refuses a change while a previous handle is still in grace, unless it takes that one back', () => {
    const rows = [r('cur', { createdAt: 0 }), r('prev', { isPrimary: false, releasedAt: NOW + 5 })];
    expect(checkClaimPolicy({ handle: 'third', drepId: D, rows, now: NOW })).toEqual({
      ok: false, error: 'previous_pending', until: NOW + 5,
    });
    expect(checkClaimPolicy({ handle: 'prev', drepId: D, rows, now: NOW })).toEqual({ ok: true });
  });
  it('passes validation errors through', () => {
    expect(checkClaimPolicy({ handle: 'ab', drepId: D, rows: [], now: NOW })).toEqual({ ok: false, error: 'length' });
  });
});

describe('nextNewHandleAt', () => {
  it('is the later of the cooldown end and the previous handle expiry', () => {
    // Day 0 change: cooldown ends on day 90, the old link expires on day 180.
    expect(nextNewHandleAt(90, 180)).toBe(180);
    expect(nextNewHandleAt(90, null)).toBe(90);
    expect(nextNewHandleAt(null, 180)).toBe(180);
    expect(nextNewHandleAt(null, null)).toBeNull();
  });
});
