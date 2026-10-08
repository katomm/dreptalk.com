// How k and a0 change a pool's maximum rewards: one curve per pledge level
// over pool stake, plus three reference pools as tiles. The lines live in a
// stretched SVG, the axis labels in HTML around it, so the labels keep their
// size on a phone.
import { memo, useMemo } from 'react';
import {
  CURVE_PLEDGES,
  rewardChange,
  rewardCurves,
  type ModelParams,
  type PoolEconomics,
} from '@/lib/governance/paramImpact.js';
import { linear, signedPct } from './chart.js';

const W = 600;
const H = 170;
const X_MIN = 2e6;
const X_MAX = 80e6;
const X_TICKS = [10e6, 30e6, 50e6, 70e6];
// The zero line is var(--muted), so no curve uses it.
const COLORS = ['var(--gov-committee)', 'var(--accent)', 'var(--gov-parameter)'];
const pledgeLabel = (pledge: number) => `${pledge / 1e6}M ₳ pledge`;

export default memo(function ImpactRewards({
  eco,
  from,
  to,
  together,
}: {
  eco: PoolEconomics;
  from: ModelParams;
  to: ModelParams;
  /** k and a0 both change, the curves show them combined. */
  together: boolean;
}) {
  // One memo for the curves and the reference pools, both read the same model.
  const { curves, ref } = useMemo(
    () => ({
      curves: rewardCurves(eco, from, to),
      ref: [
        { label: '30M ₳ pool, 1M pledge', change: rewardChange(eco, from, to, 30e6, 1e6) },
        { label: '30M ₳ pool, 10M pledge', change: rewardChange(eco, from, to, 30e6, 10e6) },
        { label: '60M ₳ pool, 30M pledge', change: rewardChange(eco, from, to, 60e6, 30e6) },
      ],
    }),
    [eco, from, to],
  );
  const pcts = curves.flatMap((c) => c.points.map(([, change]) => change * 100));
  // Keep a minimal span around zero so the 5% grid never collapses when the curves are flat.
  const lo = Math.min(-5, Math.floor(Math.min(...pcts) / 5) * 5);
  const hi = Math.max(5, Math.ceil(Math.max(...pcts) / 5) * 5);
  const x = linear([X_MIN, X_MAX], [0, 100]);
  // A little inset at both ends keeps the outer axis labels inside the plot.
  const y = linear([hi, lo], [4, 96]);
  const grid: number[] = [];
  for (let v = hi; v >= lo; v -= 5) grid.push(v);

  const summary = `Change in a pool's maximum rewards by pool stake, for ${CURVE_PLEDGES.map((p) => `${p / 1e6}M`).join(', ')} ₳ pledge. ${ref
    .map((r) => `${r.label}: ${signedPct(r.change)}`)
    .join('. ')}.`;

  return (
    <>
      <div className="pcp-plot">
        <div className="pcp-plot__y" aria-hidden="true">
          {grid.map((v) => (
            <span key={v} className="pcp-tick" style={{ top: `${y(v)}%` }}>
              {v > 0 ? '+' : ''}
              {v}%
            </span>
          ))}
        </div>
        <div className="pcp-plot__area">
          <svg className="pcp-chart pcp-chart--rewards" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary}>
            {grid.map((v) => (
              <line key={v} x1={0} x2={W} y1={(y(v) / 100) * H} y2={(y(v) / 100) * H} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
            ))}
            <line x1={0} x2={W} y1={(y(0) / 100) * H} y2={(y(0) / 100) * H} stroke="var(--muted)" vectorEffect="non-scaling-stroke" />
            {curves.map((c, i) => (
              <polyline
                key={c.pledge}
                fill="none"
                stroke={COLORS[i]}
                strokeWidth={2.2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                points={c.points.map(([stake, change]) => `${((x(stake) / 100) * W).toFixed(1)},${((y(change * 100) / 100) * H).toFixed(1)}`).join(' ')}
              />
            ))}
          </svg>
          <div className="pcp-plot__x" aria-hidden="true">
            {X_TICKS.map((s) => (
              <span key={s} className="pcp-tick" style={{ left: `${x(s)}%` }}>
                {s / 1e6}M ₳
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="pcp-legend">
        {CURVE_PLEDGES.map((pledge, i) => (
          <span key={pledge} className="pcp-legend__item">
            <i className="pcp-swatch" style={{ background: COLORS[i] }} />
            {pledgeLabel(pledge)}
          </span>
        ))}
        <span className="pcp-legend__note">Pool stake against the change in its maximum rewards{together ? ', k and a0 together' : ''}</span>
      </div>
      <div className="pcp-stats">
        {ref.map((r) => (
          <div className="pcp-stat" key={r.label}>
            <div className="pcp-stat__k">{r.label}</div>
            <div className="pcp-stat__v"><span className="pcp-nb">{signedPct(r.change)}</span></div>
          </div>
        ))}
      </div>
      <p className="pcp-why">Maximum rewards at full block production, before fees.</p>
      {to.a0 > from.a0 && (
        <p className="pcp-why">
          A higher a0 first lowers every pool's rewards by the factor 1/(1+a0). The pledge bonus wins part of it back,
          mostly for pools with high pledge close to saturation.
        </p>
      )}
    </>
  );
});
