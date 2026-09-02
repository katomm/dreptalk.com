// BigInt-safe percentage: lovelace totals exceed Number's exact-integer range,
// so the division happens in BigInt and only the four-decimal result becomes a
// float. Zero when the whole is not positive, a share of nothing is nothing.
export function pct4(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 1_000_000n) / whole) / 10_000;
}
