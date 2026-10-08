// What a new k does to the saturation point: the largest 300 pools as bars
// against the old and the new point, and how much stake ends up over it.
// The bars live in a stretched SVG, the axis ticks and line labels in HTML
// around it, so the labels keep their size on a phone.
import { memo, useMemo } from 'react';
import { saturation, type ModelParams, type PoolEconomics } from '@/lib/governance/paramImpact.js';
import { adaCompact, LegendItem, linear, niceTicks, Stat } from './chart.js';

const SHOWN_POOLS = 300;
const W = 600;
const H = 160;
// Headroom above the bars so the higher dashed line never touches the top edge.
const TOP = 8;
// At most this many clipped bars get their real value as a label.
const CLIP_LABELS = 3;
// Rank ticks in between the first and the last pool, the last one needs this much room.
const RANK_STEP = 100;

export default memo(function ImpactSaturation({ eco, from, to }: { eco: PoolEconomics; from: ModelParams; to: ModelParams }) {
  const { k: kFrom } = from;
  const { k: kTo } = to;
  const s = useMemo(() => saturation(eco, kFrom, kTo), [eco, kFrom, kTo]);
  const top = eco.pools.slice(0, SHOWN_POOLS);
  // A few very large pools would flatten the chart, so bars are clipped.
  const clip = Math.max(s.pointFrom, s.pointTo) * 1.35;
  const clipped = top.filter((pool) => pool.stake > clip);
  const y = linear([0, clip], [H, TOP]);
  const pct = (stake: number) => (y(stake) / H) * 100;
  const barY = (stake: number) => y(Math.min(stake, clip));
  const bw = W / Math.max(top.length, 1);
  const rankX = (rank: number) => (((rank - 0.5) * bw) / W) * 100;
  const ranks = [1];
  for (let r = RANK_STEP; r <= top.length - RANK_STEP / 2; r += RANK_STEP) ranks.push(r);
  if (top.length > 1) ranks.push(top.length);
  // The higher line carries its label above it, the lower one below, so the two never collide.
  const fromHigher = s.pointFrom >= s.pointTo;
  // A slanted break across the tops of the clipped bars marks the cut: a gap
  // in the card color with a muted edge on both sides.
  const groupW = clipped.length * bw;
  const cut = (dy: number) => `0,${TOP + 9 + dy} ${groupW.toFixed(2)},${TOP + 3 + dy}`;
  const clipNote = clipped.length
    ? ` The ${clipped.length === 1 ? 'largest pool is' : `${clipped.length} largest pools are`} clipped at ${adaCompact(clip)}, the largest has ${adaCompact(clipped[0].stake)}.`
    : '';
  const summary = `Active stake of the largest ${top.length} pools by rank. The saturation point moves from ${adaCompact(s.pointFrom)} to ${adaCompact(s.pointTo)}, with ${s.aboveTo} pools above it instead of ${s.aboveFrom}, and ${adaCompact(s.excessTo)} of stake over saturation instead of ${adaCompact(s.excessFrom)}.${clipNote}`;

  return (
    <>
      <div className="pcp-plot pcp-plot--ada">
        <div className="pcp-plot__area">
          {clipped.length > 0 && (
            <div className="pcp-clips" aria-hidden="true">
              {clipped.slice(0, CLIP_LABELS).map((pool, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: labels are positional, two pools can share a stake
                <span key={i} className="pcp-nb">
                  {adaCompact(pool.stake)}
                </span>
              ))}
            </div>
          )}
          <div className="pcp-plot__frame">
            <div className="pcp-plot__y" aria-hidden="true">
              {niceTicks(clip).map((v) => (
                <span key={v} className="pcp-tick" style={{ top: `${pct(v)}%` }}>
                  {adaCompact(v)}
                </span>
              ))}
            </div>
            <svg className="pcp-chart pcp-chart--sat" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary}>
              {top.map((pool, i) => (
                <rect
                  // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional, two pools can share a stake
                  key={i}
                  x={(i * bw).toFixed(2)}
                  y={barY(pool.stake).toFixed(1)}
                  width={Math.max(bw - 0.4, 0.6).toFixed(2)}
                  height={(H - barY(pool.stake)).toFixed(1)}
                  fill={pool.stake > s.pointTo ? 'var(--warn)' : 'var(--pcp-bar)'}
                />
              ))}
              {clipped.length > 0 && (
                <g>
                  <polygon points={`${cut(0)} ${groupW.toFixed(2)},${TOP + 6} 0,${TOP + 12}`} fill="var(--bg)" />
                  <polyline points={cut(0)} fill="none" stroke="var(--muted)" vectorEffect="non-scaling-stroke" />
                  <polyline points={cut(3)} fill="none" stroke="var(--muted)" vectorEffect="non-scaling-stroke" />
                </g>
              )}
              <line x1={0} x2={W} y1={y(s.pointFrom)} y2={y(s.pointFrom)} stroke="var(--muted)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
              <line x1={0} x2={W} y1={y(s.pointTo)} y2={y(s.pointTo)} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="6 3" vectorEffect="non-scaling-stroke" />
            </svg>
            <span
              className={`pcp-linelabel pcp-linelabel--now pcp-linelabel--${fromHigher ? 'above' : 'below'}`}
              style={{ top: `${pct(s.pointFrom)}%` }}
              aria-hidden="true"
            >
              now {adaCompact(s.pointFrom)}
            </span>
            <span
              className={`pcp-linelabel pcp-linelabel--new pcp-linelabel--${fromHigher ? 'below' : 'above'}`}
              style={{ top: `${pct(s.pointTo)}%` }}
              aria-hidden="true"
            >
              new {adaCompact(s.pointTo)}
            </span>
          </div>
          <div className="pcp-plot__x pcp-plot__x--ends" aria-hidden="true">
            {ranks.map((rank) => (
              <span key={rank} className="pcp-tick" style={{ left: `${rankX(rank)}%` }}>
                {rank}
              </span>
            ))}
          </div>
          <p className="pcp-axis-title pcp-axis-title--x">Pool rank by active stake</p>
        </div>
      </div>
      <div className="pcp-legend">
        <LegendItem color="var(--pcp-bar)">Largest {top.length} pools by active stake</LegendItem>
        <LegendItem color="var(--warn)">Above the new saturation point</LegendItem>
      </div>
      <div className="pcp-stats">
        <Stat label="Saturation point" value={adaCompact(s.pointTo)} from={adaCompact(s.pointFrom)} />
        <Stat label="Pools above it" value={s.aboveTo} from={s.aboveFrom} />
        <Stat label="Stake over saturation" value={adaCompact(s.excessTo)} from={adaCompact(s.excessFrom)} />
      </div>
      {kTo > kFrom && (
        <p className="pcp-why">
          These pools' maximum rewards are capped lower, so their delegators would earn less unless they move to a
          smaller pool. A higher k also changes the pledge bonus of pools below it.
        </p>
      )}
      {kTo < kFrom && (
        <p className="pcp-why">A lower k raises the saturation point, so large pools can grow further before rewards are capped.</p>
      )}
    </>
  );
});
