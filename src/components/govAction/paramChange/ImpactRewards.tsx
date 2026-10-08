// How the reward parameters change a pool's maximum rewards: one curve per
// pledge level over pool stake, the old and the new saturation point as
// dashed lines, plus three reference pools as tiles. A caption above names
// the changes the chart is calculated with. The lines live in a stretched
// SVG, the axis labels in HTML around it, so the labels keep their size on a
// phone.
import { memo, useMemo, type ReactNode } from 'react';
import {
  CURVE_PLEDGES,
  rewardChange,
  rewardCurves,
  samplePools,
  type ModelParams,
  type PoolEconomics,
} from '@/lib/governance/paramImpact.js';
import { adaCompact, LegendItem, linear, niceTicks, signedPct, Stat } from './chart.js';

/** One picked change the chart is calculated with, already formatted. */
export interface RewardBasis {
  short: string;
  from: string;
  to: string;
}

const W = 600;
const H = 170;
// The zero line is var(--muted), so no curve uses it.
const COLORS = ['var(--gov-committee)', 'var(--accent)', 'var(--gov-parameter)'];
const pledgeLabel = (pledge: number) => `${adaCompact(pledge)} pledge`;
// Below this share of the width a label left of the lower line would run into the y axis.
const LEFT_LABEL_MIN_PCT = 35;

/** "a, b and c" */
function listOf<T>(items: readonly T[], render: (item: T) => ReactNode) {
  return items.map((item, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the list order is the picked order and never reorders in place
    <span key={i}>
      {i > 0 && (i === items.length - 1 ? ' and ' : ', ')}
      {render(item)}
    </span>
  ));
}

export default memo(function ImpactRewards({
  eco,
  from,
  to,
  basis,
}: {
  eco: PoolEconomics;
  from: ModelParams;
  to: ModelParams;
  /** Every picked reward parameter change with a valid value, for the caption. */
  basis: readonly RewardBasis[];
}) {
  // One memo for the curves and the reference pools, both read the same model.
  const { range, ref } = useMemo(
    () => ({
      range: rewardCurves(eco, from, to),
      ref: samplePools(eco, to.k).map((pool) => ({
        label: (
          <>
            <span className="pcp-nb">{adaCompact(pool.stake)} pool</span>, <span className="pcp-nb">{pledgeLabel(pool.pledge)}</span>
          </>
        ),
        text: `${adaCompact(pool.stake)} pool, ${pledgeLabel(pool.pledge)}`,
        change: rewardChange(eco, from, to, pool.stake, pool.pledge),
      })),
    }),
    [eco, from, to],
  );
  const { xMin, xMax, pointFrom, pointTo, curves } = range;
  const pcts = curves.flatMap((c) => c.points.map(([, change]) => change * 100));
  // Keep a minimal span around zero so the 5% grid never collapses when the curves are flat.
  const lo = Math.min(-5, Math.floor(Math.min(...pcts) / 5) * 5);
  const hi = Math.max(5, Math.ceil(Math.max(...pcts) / 5) * 5);
  const x = linear([xMin, xMax], [0, 100]);
  // A little inset at both ends keeps the outer axis labels inside the plot.
  const y = linear([hi, lo], [4, 96]);
  const grid: number[] = [];
  for (let v = hi; v >= lo; v -= 5) grid.push(v);
  const xTicks = niceTicks(xMax).filter((v) => v >= xMin);

  // The saturation points as dashed lines. The higher one is labeled to its
  // right. The lower one to its left, or on a second row when that would run
  // into the y axis. One line when k does not change.
  const kChanges = pointFrom !== pointTo;
  const lowerLeft = x(Math.min(pointFrom, pointTo)) >= LEFT_LABEL_MIN_PCT;
  const marks = kChanges
    ? [
        { at: pointFrom, label: 'saturation now', tone: 'now' },
        { at: pointTo, label: 'saturation new', tone: 'new' },
      ].map((m) => {
        const lower = m.at < Math.max(pointFrom, pointTo);
        return { ...m, place: lower ? (lowerLeft ? 'left' : 'below') : 'right' };
      })
    : [{ at: pointTo, label: 'saturation point', tone: 'now', place: 'right' }];
  const twoRows = marks.some((m) => m.place === 'below');

  const basisText = basis.map((b) => `${b.short} ${b.from} to ${b.to}`).join(' and ');
  const saturationText = kChanges
    ? `The saturation point moves from ${adaCompact(pointFrom)} to ${adaCompact(pointTo)}.`
    : `The saturation point stays at ${adaCompact(pointTo)}.`;
  const summary = `Change in a pool's maximum rewards by pool stake from ${adaCompact(xMin)} to ${adaCompact(xMax)}, calculated with ${basisText}, for ${curves.map((c) => adaCompact(c.pledge)).join(', ')} pledge. ${saturationText} ${ref
    .map((r) => `${r.text}: ${signedPct(r.change)}`)
    .join('. ')}.`;

  return (
    <>
      {basis.length > 0 && (
        <p className="pcp-caption">
          Calculated with{' '}
          {listOf(basis, (b) => (
            <span className="pcp-nb">
              {b.short} {b.from} → {b.to}
            </span>
          ))}
        </p>
      )}
      <div className="pcp-plot">
        <p className="pcp-axis-title">Change in maximum rewards</p>
        <div className="pcp-plot__area">
          <div className={twoRows ? 'pcp-vlabels pcp-vlabels--two' : 'pcp-vlabels'} aria-hidden="true">
            {marks.map((m) => (
              <span key={m.label} className={`pcp-vlabel pcp-vlabel--${m.tone} pcp-vlabel--${m.place}`} style={{ left: `${x(m.at)}%` }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="pcp-plot__frame">
            <div className="pcp-plot__y" aria-hidden="true">
              {grid.map((v) => (
                <span key={v} className="pcp-tick" style={{ top: `${y(v)}%` }}>
                  {v > 0 ? '+' : ''}
                  {v}%
                </span>
              ))}
            </div>
            <svg className="pcp-chart pcp-chart--rewards" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary}>
              {grid.map((v) => (
                <line key={v} x1={0} x2={W} y1={(y(v) / 100) * H} y2={(y(v) / 100) * H} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
              ))}
              <line x1={0} x2={W} y1={(y(0) / 100) * H} y2={(y(0) / 100) * H} stroke="var(--muted)" vectorEffect="non-scaling-stroke" />
              {marks.map((m) => (
                <line
                  key={m.label}
                  x1={(x(m.at) / 100) * W}
                  x2={(x(m.at) / 100) * W}
                  y1={0}
                  y2={H}
                  stroke={m.tone === 'new' ? 'var(--accent)' : 'var(--muted)'}
                  strokeDasharray={m.tone === 'new' ? '6 3' : '4 4'}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {curves.map((c) => (
                <polyline
                  key={c.pledge}
                  fill="none"
                  stroke={COLORS[CURVE_PLEDGES.indexOf(c.pledge)]}
                  strokeWidth={2.2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  points={c.points.map(([stake, change]) => `${((x(stake) / 100) * W).toFixed(1)},${((y(change * 100) / 100) * H).toFixed(1)}`).join(' ')}
                />
              ))}
            </svg>
          </div>
          <div className="pcp-plot__x" aria-hidden="true">
            {xTicks.map((s) => (
              <span key={s} className="pcp-tick" style={{ left: `${x(s)}%` }}>
                {adaCompact(s)}
              </span>
            ))}
          </div>
          <p className="pcp-axis-title pcp-axis-title--x">Pool stake</p>
        </div>
      </div>
      <div className="pcp-legend">
        {curves.map((c) => (
          <LegendItem key={c.pledge} color={COLORS[CURVE_PLEDGES.indexOf(c.pledge)]}>
            {pledgeLabel(c.pledge)}
          </LegendItem>
        ))}
      </div>
      <div className="pcp-stats">
        {ref.map((r) => (
          <Stat key={r.text} label={r.label} value={signedPct(r.change)} />
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
