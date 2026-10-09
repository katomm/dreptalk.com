// What a new minimum pool cost means for the pools of today: their fixed
// costs in 25 ada bins, every bin that covers costs below the new minimum
// highlighted, with markers for the current and the new minimum.
import { memo, useMemo } from 'react';
import { BIN_ADA, BIN_MAX_ADA, minPoolCostImpact, type PoolEconomics } from '@/lib/governance/paramImpact.js';
import { formatParamValue } from '@/lib/governance/paramDefs.js';
import { LegendItem, Stat } from './chart.js';

const TICKS = [0, 100, 200, 300, 400, BIN_MAX_ADA];

export default memo(function ImpactMinPoolCost({
  eco,
  currentLovelace,
  nextLovelace,
}: {
  eco: PoolEconomics;
  currentLovelace: bigint;
  nextLovelace: bigint;
}) {
  const { below, atCurrent, bins } = useMemo(
    () => minPoolCostImpact(eco, currentLovelace, nextLovelace),
    [eco, currentLovelace, nextLovelace],
  );
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
            // A bin starting below the new minimum covers costs under it,
            // even when its top is above.
            data-hit={bin.fromAda < nextAda ? 'true' : undefined}
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
            {ada === BIN_MAX_ADA ? `${BIN_MAX_ADA}+ ₳` : `${ada} ₳`}
          </span>
        ))}
      </div>
      <div className="pcp-legend">
        <LegendItem color="var(--pcp-bar)">Pools by fixed cost</LegendItem>
        <LegendItem color="var(--warn)">Covers costs below the new minimum</LegendItem>
      </div>
      <div className="pcp-stats">
        <Stat label={<>Pools charging less than {nextLabel}</>} value={below} />
        <Stat label="Pools at the current minimum" value={atCurrent} />
      </div>
      <p className="pcp-why">The minimum is enforced when a pool registers or updates its parameters.</p>
    </>
  );
});
