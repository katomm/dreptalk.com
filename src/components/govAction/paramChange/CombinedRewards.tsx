// The rewards chart for two or more reward parameter changes together, in one
// section below the cards. Presentational, the caller decides when it shows.
import type { ModelParams } from '@/lib/governance/paramImpact.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import type { PoolEconomicsState } from './usePoolEconomics.js';
import ImpactRewards, { type RewardBasis } from './ImpactRewards.js';
import { EconomicsPending } from './ParamImpact.js';
import { DataSource } from './chart.js';

export default function CombinedRewards({
  economics,
  onRetry,
  model,
  rewardBasis,
  network,
  titleId,
}: {
  economics: PoolEconomicsState;
  onRetry: () => void;
  model: { from: ModelParams; to: ModelParams } | null;
  rewardBasis: readonly RewardBasis[];
  network: CardanoNetwork;
  /** The id the section's heading carries, it names the section. */
  titleId: string;
}) {
  return (
    <section className="pcp-card pcp-combined" aria-labelledby={titleId}>
      <h3 id={titleId} className="pcp-card__title pcp-combined__title">
        Combined impact of this proposal
      </h3>
      <div className="pcp-impact">
        {economics.status === 'ready' && model ? (
          <>
            <ImpactRewards eco={economics.data} from={model.from} to={model.to} basis={rewardBasis} />
            <DataSource network={network} epoch={economics.data.epoch} />
          </>
        ) : (
          <EconomicsPending economics={economics} onRetry={onRetry} />
        )}
      </div>
    </section>
  );
}
