// Small helpers for the impact charts: compact ada labels, percentage
// labels, linear scales and axis ticks, and the stat tile, legend entry and
// data source line they all share.
import type { ReactNode } from 'react';
import type { CardanoNetwork } from '@/lib/config/network.js';

/** Drops a trailing zero fraction, so 1.0M reads 1M. */
const trim = (fixed: string) => fixed.replace(/\.0+$/, '');

export const adaCompact = (ada: number): string =>
  ada >= 1e9
    ? `${trim((ada / 1e9).toFixed(2))}B ₳`
    : ada >= 1e6
      ? `${trim((ada / 1e6).toFixed(1))}M ₳`
      : `${Math.round(ada).toLocaleString('en-US')} ₳`;

export const signedPct = (fraction: number): string => `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(1)}%`;

export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  return (v: number) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
}

/** Round tick values from above zero up to `max`, about `count` of them, in steps of 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(max: number, count = 5): number[] {
  if (!(max > 0)) return [];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((f) => f * magnitude >= raw) ?? 10) * magnitude;
  const ticks: number[] = [];
  for (let i = 1; step * i <= max * (1 + 1e-9); i++) ticks.push(step * i);
  return ticks;
}

/** Where the pool figures come from, under every impact section. */
export function DataSource({ network, epoch }: { network: CardanoNetwork; epoch: number }) {
  return (
    <p className="pcp-source">
      {network === 'mainnet' ? 'Mainnet' : 'Preprod'} pool data, epoch {epoch}
    </p>
  );
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
