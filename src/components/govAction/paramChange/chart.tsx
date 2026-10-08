// Small helpers for the impact charts: compact ada labels, percentage
// labels, linear scales, and the stat tile and legend entry they all share.
import type { ReactNode } from 'react';

export const adaCompact = (ada: number): string =>
  ada >= 1e9 ? `${(ada / 1e9).toFixed(2)}B ₳` : ada >= 1e6 ? `${(ada / 1e6).toFixed(1)}M ₳` : `${Math.round(ada).toLocaleString('en-US')} ₳`;

export const signedPct = (fraction: number): string => `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(1)}%`;

export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  return (v: number) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
}

/** One figure under a chart, optionally with the value it moves from. */
export function Stat({ label, value, from }: { label: ReactNode; value: ReactNode; from?: ReactNode }) {
  return (
    <div className="pcp-stat">
      <div className="pcp-stat__k">{label}</div>
      <div className="pcp-stat__v">
        <span className="pcp-nb">{value}</span>
        {from !== undefined && (
          <>
            {' '}
            <small className="pcp-nb">from {from}</small>
          </>
        )}
      </div>
    </div>
  );
}

/** One legend entry: a swatch, or a short line with `line`, then the label. */
export function LegendItem({ color, line = false, children }: { color: string; line?: boolean; children: ReactNode }) {
  return (
    <span className="pcp-legend__item">
      <i className={line ? 'pcp-swatch pcp-swatch--line' : 'pcp-swatch'} style={{ background: color }} />
      {children}
    </span>
  );
}
