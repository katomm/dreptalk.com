/**
 * Median of a list of numbers: null when empty, the middle value at odd
 * length, and the mean of the two middle values at even length. Sorts
 * numerically, since the default Array.prototype.sort orders values as
 * strings, and sorts a copy so the caller's array keeps its own order.
 * The single definition every analytics view shares, so the snapshot reducer
 * and the live fallback path stay numerically identical.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
