import { describe, it, expect } from 'vitest';
import { claimErrorMessage, formatLinkDate } from './messages.js';

const ALL = ['taken', 'reserved', 'length', 'shape', 'id_namespace', 'unchanged', 'cooldown', 'previous_pending', 'stale', 'not_open', 'not_synced', 'not_registered', 'rate_limited'];
const UNTIL = 1_800_000_000;

describe('claimErrorMessage', () => {
  it('has a distinct text for every error the API can return and a fallback for unknown ones', () => {
    const fallback = claimErrorMessage('whatever', null);
    const texts = ALL.map((e) => claimErrorMessage(e, UNTIL));
    for (const t of texts) expect(t).not.toBe(fallback);
    expect(new Set(texts).size).toBe(ALL.length);
  });
  it('names the date when a cooldown or a pending previous link ends', () => {
    expect(claimErrorMessage('cooldown', UNTIL)).toContain(formatLinkDate(UNTIL));
    expect(claimErrorMessage('previous_pending', UNTIL)).toContain(formatLinkDate(UNTIL));
  });
});
