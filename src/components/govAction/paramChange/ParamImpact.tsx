// The live impact of one parameter change, the charts under its card in the
// builder and on the proposal page. Presentational, the caller loads the pool
// data and builds the model.
import type { ReactNode } from 'react';
import type { ParamKey } from '@/lib/governance/paramDefs.js';
import type { Rational } from '@/lib/format/rational.js';
import type { ModelParams } from '@/lib/governance/paramImpact.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import type { PoolEconomicsState } from './usePoolEconomics.js';
import ImpactSaturation from './ImpactSaturation.js';
import ImpactRewards, { type RewardBasis } from './ImpactRewards.js';
import ImpactMinPoolCost from './ImpactMinPoolCost.js';
import ImpactBudget from './ImpactBudget.js';
import ImpactUtxoCost from './ImpactUtxoCost.js';
import { DataSource } from './chart.js';

export interface ParamImpactProps {
  paramKey: ParamKey;
  /** The value in force, null when the chain did not report it. */
  current: Rational | null;
  /** The proposed value. */
  next: Rational;
  economics: PoolEconomicsState;
  onRetryEconomics: () => void;
  /**
   * The impact model before and after, built from every valid picked value. Null when it cannot be
   * built.
   */
  model: { from: ModelParams; to: ModelParams } | null;
  /**
   * Where the rewards chart goes: with this parameter, in the combined section, or nowhere for this
   * parameter.
   */
  rewards: 'here' | 'combined' | null;
  /** The picked reward parameter changes the rewards chart is calculated with. */
  rewardBasis: readonly RewardBasis[];
  network: CardanoNetwork;
}

/**
 * The pool data while it loads or after it failed, shared with the combined section. Null once it
 * is ready.
 */
export function EconomicsPending({ economics, onRetry }: { economics: PoolEconomicsState; onRetry: () => void }) {
  if (economics.status === 'loading') return <p className="pcp-why">Loading pool data...</p>;
  if (economics.status === 'error') {
    return (
      <p className="pcp-why">
        <span>Impact figures are unavailable right now.</span>{' '}
        <button type="button" className="pcp-linkbtn" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  return null;
}

export default function ParamImpact({
  paramKey,
  current,
  next,
  economics,
  onRetryEconomics,
  model,
  rewards,
  rewardBasis,
  network,
}: ParamImpactProps) {
  // The minimum ada chart reads no pool data, so it skips the pool data gate.
  if (paramKey === 'utxoCostPerByte') {
    return current ? <ImpactUtxoCost currentLovelace={current.n / current.d} nextLovelace={next.n / next.d} /> : null;
  }
  // The combined section below the cards shows the pool data state and the chart for a0.
  if (paramKey === 'a0' && rewards === 'combined') {
    return <p className="pcp-why">Its effect on pool rewards is shown under Combined impact below.</p>;
  }
  if (economics.status !== 'ready') return <EconomicsPending economics={economics} onRetry={onRetryEconomics} />;
  const eco = economics.data;
  // The fixed cost histogram reads the pool list and the two minimums only, so it needs no model.
  if (paramKey === 'minPoolCost') {
    if (!current) return null;
    return (
      <>
        <ImpactMinPoolCost eco={eco} currentLovelace={current.n / current.d} nextLovelace={next.n / next.d} />
        <DataSource network={network} epoch={eco.epoch} source="pools" />
      </>
    );
  }
  if (!model || !current) return null;
  const rewardsChart = <ImpactRewards eco={eco} from={model.from} to={model.to} basis={rewardBasis} />;
  let body: ReactNode;
  // The budget cards read the epoch totals, every other card the pool list.
  let source: 'pools' | 'totals' = 'pools';
  switch (paramKey) {
    case 'k':
      body = (
        <>
          <ImpactSaturation eco={eco} from={model.from} to={model.to} />
          {rewards === 'here' && <div className="pcp-impact__more">{rewardsChart}</div>}
        </>
      );
      break;
    case 'a0':
      body = rewardsChart;
      break;
    case 'rho':
    case 'tau':
      body = <ImpactBudget eco={eco} from={model.from} to={model.to} />;
      source = 'totals';
      break;
  }
  return (
    <>
      {body}
      <DataSource network={network} epoch={eco.epoch} source={source} />
    </>
  );
}
