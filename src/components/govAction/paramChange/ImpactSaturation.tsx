// What a new k does to the saturation point: the largest 300 pools as bars
// against the old and the new point, and how much stake ends up above it.
import { saturation, type ModelParams, type PoolEconomics } from '@/lib/governance/paramImpact.js';
import { adaCompact, linear } from './chart.js';

const SHOWN_POOLS = 300;
const W = 600;
const H = 160;
// Headroom above the bars so the higher dashed line never touches the top edge.
const TOP = 8;

export default function ImpactSaturation({ eco, from, to }: { eco: PoolEconomics; from: ModelParams; to: ModelParams }) {
  const s = saturation(eco, from.k, to.k);
  const top = eco.pools.slice(0, SHOWN_POOLS);
  // A few very large pools would flatten the chart, so bars are clipped.
  const clip = Math.max(s.pointFrom, s.pointTo) * 1.35;
  const y = linear([0, clip], [H, TOP]);
  const barY = (stake: number) => y(Math.min(stake, clip));
  const bw = W / Math.max(top.length, 1);
  const summary = `Active stake of the largest ${top.length} pools. The saturation point moves from ${adaCompact(s.pointFrom)} to ${adaCompact(s.pointTo)}, with ${s.aboveTo} pools above it instead of ${s.aboveFrom}, and ${adaCompact(s.excessTo)} of stake above the cap.`;

  return (
    <>
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
        <line x1={0} x2={W} y1={y(s.pointFrom)} y2={y(s.pointFrom)} stroke="var(--muted)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={W} y1={y(s.pointTo)} y2={y(s.pointTo)} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="6 3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="pcp-legend">
        <span><i className="pcp-swatch" style={{ background: 'var(--pcp-bar)' }} />Largest {top.length} pools by active stake</span>
        <span><i className="pcp-swatch" style={{ background: 'var(--warn)' }} />Above the new saturation point</span>
        <span><i className="pcp-swatch pcp-swatch--line" style={{ background: 'var(--accent)' }} />New point {adaCompact(s.pointTo)}</span>
        <span><i className="pcp-swatch pcp-swatch--line" style={{ background: 'var(--muted)' }} />Now {adaCompact(s.pointFrom)}</span>
      </div>
      <div className="pcp-stats">
        <div className="pcp-stat">
          <div className="pcp-stat__k">Saturation point</div>
          <div className="pcp-stat__v">{adaCompact(s.pointTo)} <small>from {adaCompact(s.pointFrom)}</small></div>
        </div>
        <div className="pcp-stat">
          <div className="pcp-stat__k">Pools above it</div>
          <div className="pcp-stat__v">{s.aboveTo} <small>from {s.aboveFrom}</small></div>
        </div>
        <div className="pcp-stat">
          <div className="pcp-stat__k">Stake above the cap</div>
          <div className="pcp-stat__v">{adaCompact(s.excessTo)}</div>
        </div>
      </div>
      {to.k > from.k && (
        <p className="pcp-why">
          Delegators of the {s.aboveTo} pools above the new point earn less until they move to a smaller pool. A higher k
          also changes the pledge bonus of pools below it, see the rewards chart.
        </p>
      )}
      {to.k < from.k && (
        <p className="pcp-why">A lower k raises the saturation point, so large pools can grow further before rewards are capped.</p>
      )}
    </>
  );
}
