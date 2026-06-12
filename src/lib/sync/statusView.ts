// Pure presentation helpers for the operator-facing /debug/sync status page.
// Times render in Europe/Berlin (a single operator, in Berlin) and the tz
// abbreviation (MEZ/MESZ) makes the offset explicit; DST is handled by Intl.
// All server-side, so no client JS is needed and the strict CSP holds. Kept out
// of the .astro so the formatting and run-state logic can be unit-tested.

const BERLIN = 'Europe/Berlin';

const dateTimeFmt = new Intl.DateTimeFormat('de-DE', {
  timeZone: BERLIN,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

const timeFmt = new Intl.DateTimeFormat('de-DE', {
  timeZone: BERLIN,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// en-CA renders an ISO-shaped YYYY-MM-DD, which sorts and compares cleanly.
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: BERLIN,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dayLabelFmt = new Intl.DateTimeFormat('de-DE', {
  timeZone: BERLIN,
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** Full Berlin date and time with tz abbreviation, e.g. "13.06.2026, 02:14 MESZ". */
export function formatBerlinDateTime(ms: number): string {
  return dateTimeFmt.format(ms);
}

/** Berlin clock time only, e.g. "02:14:30"; used once a day header carries the date. */
export function formatBerlinTime(ms: number): string {
  return timeFmt.format(ms);
}

/** Stable Berlin calendar-day key (YYYY-MM-DD) for grouping consecutive rows. */
export function berlinDayKey(ms: number): string {
  return dayKeyFmt.format(ms);
}

/** Human day label for a group header, e.g. "Fr., 13.06.2026". */
export function formatBerlinDayLabel(ms: number): string {
  return dayLabelFmt.format(ms);
}

// A run row is written with finished_at NULL at start and finalized at the end.
// recordSyncRun finalizes on success and on caught errors alike, so a row left
// NULL well past any plausible run was hard-killed by the runtime (execution
// limit / eviction) before it could finalize. Real runs finish in well under
// this window, so anything older is reported as killed rather than running.
export const RUNNING_GRACE_MS = 10 * 60 * 1000;

export type RunDisplay =
  | { state: 'done'; text: string }
  | { state: 'running'; text: string }
  | { state: 'killed'; text: string };

/** Distinguishes a finished run (with duration) from one still running vs killed. */
export function runDisplay(
  run: { startedAt: number; finishedAt: number | null },
  now: number,
): RunDisplay {
  if (run.finishedAt != null) {
    const sec = (run.finishedAt - run.startedAt) / 1000;
    return { state: 'done', text: sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s` };
  }
  if (now - run.startedAt < RUNNING_GRACE_MS) {
    return { state: 'running', text: 'running' };
  }
  return { state: 'killed', text: 'killed' };
}

export type DayGroupItem<R> = { type: 'day'; key: string; label: string } | { type: 'run'; run: R };

/**
 * Walks runs in their given order (newest first) and inserts a day-header item
 * whenever the Berlin calendar day changes, so each run row can show clock time
 * only. The date lives once per day in the header instead of on every row.
 */
export function groupRunsByDay<R extends { startedAt: number }>(runs: R[]): DayGroupItem<R>[] {
  const items: DayGroupItem<R>[] = [];
  let lastDay: string | null = null;
  for (const run of runs) {
    const key = berlinDayKey(run.startedAt);
    if (key !== lastDay) {
      items.push({ type: 'day', key, label: formatBerlinDayLabel(run.startedAt) });
      lastDay = key;
    }
    items.push({ type: 'run', run });
  }
  return items;
}
