// The bits the history modal and the no-JS history page must agree on. Both import
// from here so the two surfaces cannot drift apart, which is the problem this
// feature exists to fix.
//
// Index convention: versions arrive newest first, so index 0 is the current body and
// a higher index is older. `to` is the newer target of the comparison and `from` the
// older baseline, giving the invariant 0 <= to < from <= count - 1. Out-of-range or
// inverted input is clamped, never flipped: flipping would silently reverse what the
// red and green markers mean.

const toIndex = (raw: unknown): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** Clamps a requested comparison into the valid range. Null when nothing can be compared. */
export function clampVersionPair(
  rawFrom: unknown,
  rawTo: unknown,
  count: number,
): { from: number; to: number } | null {
  if (count < 2) return null;
  // to can never be the oldest version, it would leave no older baseline.
  const to = Math.min(toIndex(rawTo) ?? 0, count - 2);
  const from = Math.min(Math.max(toIndex(rawFrom) ?? to + 1, to + 1), count - 1);
  return { from, to };
}

/** "Current" for the live body, otherwise a 1-based number counting from the oldest. */
export function versionLabel(index: number, count: number, current: boolean): string {
  return current ? 'Current' : `Version ${count - index}`;
}

/**
 * One fixed locale and a pinned UTC zone, so the SSR page (a Worker, always UTC) and the
 * modal (the reader's browser, almost never UTC) print the identical string. Without the
 * pinned zone, toLocaleString falls back to the host environment's zone and the two
 * surfaces disagree, including on the date near midnight, which is exactly what this
 * module exists to prevent. The trailing "UTC" marker keeps a reader from assuming the
 * time shown is their own local time.
 */
export function formatVersionTime(at: number): string {
  const formatted = new Date(at).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  return `${formatted} UTC`;
}

/** The change summary. Word counts, or a plain phrase when no words moved. */
export function statText(added: number, removed: number, changed: boolean): string {
  if (added === 0 && removed === 0) return changed ? 'formatting only' : 'no change';
  return `+${added} / -${removed}`;
}
