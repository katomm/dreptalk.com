/**
 * Median of a list of numbers: null when empty, the middle value at odd
 * length, and the mean of the two middle values at even length. Lifted out of
 * votingTimingView so the snapshot reducer computes the stored half-turnout
 * figure with exactly the logic the view used before, which is what keeps the
 * snapshot path and the live fallback path numerically identical. Sorts
 * numerically, since the default Array.prototype.sort orders values as strings.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
