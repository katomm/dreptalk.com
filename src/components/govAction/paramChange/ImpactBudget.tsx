// What rho and tau do to the flow out of the reserve per epoch: the draw,
// the treasury's cut of it and what is left for stakers and pools.
import { memo, useMemo } from 'react';
import { budget, type ModelParams, type PoolEconomics } from '@/lib/governance/paramImpact.js';
import { adaCompact, Stat } from './chart.js';

export default memo(function ImpactBudget({ eco, from, to }: { eco: PoolEconomics; from: ModelParams; to: ModelParams }) {
  const b = useMemo(() => budget(eco, from, to), [eco, from, to]);
  const tiles = [
    { label: 'From the reserve per epoch', to: b.drawTo, from: b.drawFrom },
    { label: 'To the treasury per epoch', to: b.treasuryTo, from: b.treasuryFrom },
    { label: 'Left for stakers and pools', to: b.stakersTo, from: b.stakersFrom },
  ];
  return (
    <>
      <div className="pcp-stats">
        {tiles.map((t) => (
          <Stat key={t.label} label={t.label} value={adaCompact(t.to)} from={adaCompact(t.from)} />
        ))}
      </div>
      <p className="pcp-why">
        Theoretical budget at full block production, before fees. Rewards that are not paid out go back to the reserve.
      </p>
    </>
  );
});
