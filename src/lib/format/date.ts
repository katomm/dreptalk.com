// ISO date without the time part, e.g. "2026-06-23".
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
