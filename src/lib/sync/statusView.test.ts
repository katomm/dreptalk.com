import { describe, it, expect } from 'vitest';
import {
  formatBerlinDateTime,
  formatBerlinTime,
  berlinDayKey,
  formatBerlinDayLabel,
  runDisplay,
  groupRunsByDay,
  RUNNING_GRACE_MS,
} from './statusView.js';

// Fixed instants (UTC) with known Berlin-local equivalents.
const SUMMER = Date.UTC(2026, 5, 13, 0, 14, 30); // 13 Jun 2026 00:14:30 UTC -> 02:14:30 CEST
const WINTER = Date.UTC(2026, 0, 15, 23, 5, 0); //  15 Jan 2026 23:05:00 UTC -> 16 Jan 00:05 CET

describe('Berlin time formatting', () => {
  it('renders full date+time with the summer tz abbreviation', () => {
    expect(formatBerlinDateTime(SUMMER)).toBe('13.06.2026, 02:14 MESZ');
  });

  it('renders the winter tz abbreviation and crosses midnight into the next day', () => {
    expect(formatBerlinDateTime(WINTER)).toBe('16.01.2026, 00:05 MEZ');
  });

  it('renders clock-only time in Berlin zone', () => {
    expect(formatBerlinTime(SUMMER)).toBe('02:14:30');
  });
});

describe('berlinDayKey', () => {
  it('keys by the Berlin calendar day, not the UTC day', () => {
    // 23:05 UTC in January is already past midnight in Berlin (CET, +1).
    expect(berlinDayKey(WINTER)).toBe('2026-01-16');
    expect(berlinDayKey(SUMMER)).toBe('2026-06-13');
  });

  it('puts two instants on the same Berlin day under the same key', () => {
    const a = Date.UTC(2026, 5, 13, 6, 0, 0);
    const b = Date.UTC(2026, 5, 13, 20, 0, 0);
    expect(berlinDayKey(a)).toBe(berlinDayKey(b));
  });
});

describe('runDisplay', () => {
  const now = Date.UTC(2026, 5, 13, 0, 30, 0);

  it('shows a rounded duration for a finished run', () => {
    expect(runDisplay({ startedAt: now - 261_000, finishedAt: now }, now)).toEqual({
      state: 'done',
      text: '261s',
    });
  });

  it('shows one decimal for sub-10s runs', () => {
    expect(runDisplay({ startedAt: now - 4200, finishedAt: now }, now)).toEqual({
      state: 'done',
      text: '4.2s',
    });
  });

  it('treats a fresh unfinished run as still running', () => {
    expect(runDisplay({ startedAt: now - 60_000, finishedAt: null }, now)).toEqual({
      state: 'running',
      text: 'running',
    });
  });

  it('treats an unfinished run past the grace window as killed', () => {
    expect(runDisplay({ startedAt: now - RUNNING_GRACE_MS - 1, finishedAt: null }, now)).toEqual({
      state: 'killed',
      text: 'killed',
    });
  });

  it('reports a reaper-finalized killed run as killed, ignoring its finish time', () => {
    // finishedAt is the reap time, not the death time, so its duration is meaningless.
    expect(runDisplay({ startedAt: now - 600_000, finishedAt: now, status: 'killed' }, now)).toEqual({
      state: 'killed',
      text: 'killed',
    });
  });
});

describe('groupRunsByDay', () => {
  it('emits a day header before each new Berlin day, runs in order', () => {
    const d1a = Date.UTC(2026, 5, 13, 6, 0, 0);
    const d1b = Date.UTC(2026, 5, 13, 5, 0, 0);
    const d0 = Date.UTC(2026, 5, 12, 12, 0, 0); // 12 Jun 14:00 CEST, genuinely the day before
    const runs = [{ startedAt: d1a }, { startedAt: d1b }, { startedAt: d0 }];
    const items = groupRunsByDay(runs);
    expect(items.map((i) => i.type)).toEqual(['day', 'run', 'run', 'day', 'run']);
    expect(items[0]).toMatchObject({ type: 'day', label: formatBerlinDayLabel(d1a) });
    expect(items[3]).toMatchObject({ type: 'day', label: formatBerlinDayLabel(d0) });
  });

  it('returns nothing for an empty list', () => {
    expect(groupRunsByDay([])).toEqual([]);
  });
});
