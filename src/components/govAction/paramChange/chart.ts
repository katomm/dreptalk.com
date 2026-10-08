// src/components/govAction/paramChange/chart.ts
// Small helpers for the inline SVG charts. Compact ada labels, percentage
// labels and linear scales, nothing else.
export const adaCompact = (ada: number): string =>
  ada >= 1e9 ? `${(ada / 1e9).toFixed(2)}B ₳` : ada >= 1e6 ? `${(ada / 1e6).toFixed(1)}M ₳` : `${Math.round(ada).toLocaleString('en-US')} ₳`;

export const signedPct = (fraction: number): string => `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(1)}%`;

export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  return (v: number) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
}
