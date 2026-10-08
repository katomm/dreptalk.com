// What a new minimum pool cost means for the pools of today: their fixed
// costs in 25 ada bins, the bins at or below the new minimum highlighted,
// with markers for the current and the new minimum.
import { minPoolCostImpact, type PoolEconomics } from '@/lib/governance/paramImpact.js';
import { formatParamValue } from '@/lib/governance/paramDefs.js';

const BIN_ADA = 25;
const TICKS = [0, 100, 200, 300, 400, 500];

export default function ImpactMinPoolCost({
  eco,
  currentLovelace,
  nextLovelace,
}: {
  eco: PoolEconomics;
  currentLovelace: bigint;
  nextLovelace: bigint;
}) {
  const { below, bins } = minPoolCostImpact(eco, currentLovelace, nextLovelace);
  const atCurrent = eco.pools.filter((pool) => pool.costLovelace === currentLovelace).length;
  const most = Math.max(1, ...bins.map((b) => b.count));
  const nextAda = Number(nextLovelace) / 1e6;
  const currentAda = Number(currentLovelace) / 1e6;
  const nextLabel = formatParamValue('minPoolCost', { n: nextLovelace, d: 1n });
  const currentLabel = formatParamValue('minPoolCost', { n: currentLovelace, d: 1n });
  // Every bin is the same width, the last one holds everything from 500 ada up.
  const xPct = (ada: number) => (Math.min(ada, bins.length * BIN_ADA) / BIN_ADA / bins.length) * 100;
  // Two labels this close would overlap, the struck old value above already names the current one.
  const labelNow = Math.abs(xPct(nextAda) - xPct(currentAda)) > 7;
  const summary = `Fixed cost of ${eco.pools.length} pools in ${BIN_ADA} ada steps. ${below} pools charge less than ${nextLabel}, the new minimum. ${atCurrent} pools charge exactly the current minimum of ${currentLabel}.`;

  return (
    <>
      <div className="pcp-bins" role="img" aria-label={summary}>
        {bins.map((bin) => (
          <div
            key={bin.fromAda}
            className="pcp-bins__bar"
            data-hit={bin.toAda !== null && bin.toAda <= nextAda ? 'true' : undefined}
            style={{ height: `${(bin.count / most) * 100}%` }}
          />
        ))}
        <div className="pcp-bins__mark pcp-bins__mark--now" style={{ left: `${xPct(currentAda)}%` }}>
          {labelNow && <span className="pcp-marklabel">now</span>}
        </div>
        <div className="pcp-bins__mark pcp-bins__mark--new" style={{ left: `${xPct(nextAda)}%` }}>
          <span className="pcp-marklabel">new</span>
        </div>
      </div>
      <div className="pcp-bins__x" aria-hidden="true">
        {TICKS.map((ada) => (
          <span key={ada} className="pcp-tick" style={{ left: `${xPct(ada)}%` }}>
            {ada === 500 ? '500+ ₳' : `${ada} ₳`}
          </span>
        ))}
      </div>
      <div className="pcp-legend">
        <span className="pcp-legend__item"><i className="pcp-swatch" style={{ background: 'var(--pcp-bar)' }} />Pools by fixed cost</span>
        <span className="pcp-legend__item"><i className="pcp-swatch" style={{ background: 'var(--warn)' }} />At or below the new minimum</span>
      </div>
      <div className="pcp-stats">
        <div className="pcp-stat">
          <div className="pcp-stat__k">Pools charging less than {nextLabel}</div>
          <div className="pcp-stat__v"><span className="pcp-nb">{below}</span></div>
        </div>
        <div className="pcp-stat">
          <div className="pcp-stat__k">Pools at the current minimum</div>
          <div className="pcp-stat__v"><span className="pcp-nb">{atCurrent}</span></div>
        </div>
      </div>
      <p className="pcp-why">The minimum is enforced when a pool registers or updates its parameters.</p>
    </>
  );
}
