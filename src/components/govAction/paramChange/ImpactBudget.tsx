// What rho and tau do to the flow out of the reserve per epoch: the draw,
// the treasury's cut of it and what is left for stakers and pools.
import { budget, type ModelParams, type PoolEconomics } from '@/lib/governance/paramImpact.js';
import { adaCompact } from './chart.js';

export default function ImpactBudget({ eco, from, to }: { eco: PoolEconomics; from: ModelParams; to: ModelParams }) {
  const b = budget(eco, from, to);
  const tiles = [
    { label: 'From the reserve per epoch', to: b.drawTo, from: b.drawFrom },
    { label: 'To the treasury per epoch', to: b.treasuryTo, from: b.treasuryFrom },
    { label: 'Left for stakers and pools', to: b.stakersTo, from: b.stakersFrom },
  ];
  return (
    <>
      <div className="pcp-stats">
        {tiles.map((t) => (
          <div className="pcp-stat" key={t.label}>
            <div className="pcp-stat__k">{t.label}</div>
            <div className="pcp-stat__v">
              {adaCompact(t.to)} <small>from {adaCompact(t.from)}</small>
            </div>
          </div>
        ))}
      </div>
      <p className="pcp-why">
        Theoretical budget at full block production, before fees. Rewards that are not paid out go back to the reserve.
      </p>
      <p className="pcp-why">Based on the reserve at epoch {eco.epoch}.</p>
    </>
  );
}
