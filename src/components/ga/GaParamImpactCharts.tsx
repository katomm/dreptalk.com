// The charts of the proposal page's impact section, one block per proposed
// parameter and the combined rewards section. Loaded on the first open, the
// island owns the pool data fetch and passes its state.
import { useId, useMemo } from 'react';
import { PARAM_DEFS, anyNeedsPoolData, formatParamValue, valuesFromJson, type ParamValues } from '@/lib/governance/paramDefs.js';
import ParamImpact from '@/components/govAction/paramChange/ParamImpact.js';
import CombinedRewards from '@/components/govAction/paramChange/CombinedRewards.js';
import { useImpactPlan } from '@/components/govAction/paramChange/impactPlan.js';
import type { PoolEconomicsState } from '@/components/govAction/paramChange/usePoolEconomics.js';
import type { GaParamImpactProps } from './GaParamImpact.js';

export default function GaParamImpactCharts({
  network,
  keys,
  current: currentJson,
  proposed: proposedJson,
  economics,
  onRetry,
}: Omit<GaParamImpactProps, 'basisEpoch' | 'outcome'> & { economics: PoolEconomicsState; onRetry: () => void }) {
  const current = useMemo(() => valuesFromJson(currentJson), [currentJson]);
  // Only the shown keys go into the model, so the charts match the blocks.
  // The parent's key list holds only keys with a proposed value.
  const next = useMemo(() => {
    const proposed = valuesFromJson(proposedJson);
    const out: ParamValues = {};
    for (const key of keys) out[key] = proposed[key];
    return out;
  }, [proposedJson, keys]);
  const { model, rewardBasis, combined, rewardsHost } = useImpactPlan(current, next);
  const idBase = useId();

  return (
    <div className="ga-impact__charts">
      <p className="ga-impact__note">
        {anyNeedsPoolData(keys)
          ? 'What the proposed values would do, computed from the current pool distribution and parameters, so read them as an estimate.'
          : 'What the proposed values would do, computed from the current parameters, so read them as an estimate.'}
      </p>
      {keys.map((key) => {
        const from = current[key];
        const to = next[key]!;
        if (!from) return null;
        const titleId = `${idBase}-${key}`;
        return (
          <section key={key} className="ga-impact__block" aria-labelledby={titleId}>
            <h3 id={titleId} className="ga-impact__title">
              {PARAM_DEFS[key].title}
            </h3>
            <p className="ga-impact__values">
              <span className="ga-impact__old">{formatParamValue(key, from)}</span>{' '}
              <span aria-hidden="true">&rarr;</span>
              <span className="sr-only"> to </span>{' '}
              <span className="ga-impact__new">{formatParamValue(key, to)}</span>
            </p>
            <div className="pcp-impact">
              <ParamImpact
                paramKey={key}
                current={from}
                next={to}
                economics={economics}
                onRetryEconomics={onRetry}
                model={model}
                rewards={combined ? 'combined' : rewardsHost === key ? 'here' : null}
                rewardBasis={rewardBasis}
                network={network}
              />
            </div>
          </section>
        );
      })}
      {combined && rewardBasis.length > 0 && (
        <CombinedRewards
          economics={economics}
          onRetry={onRetry}
          model={model}
          rewardBasis={rewardBasis}
          network={network}
          titleId={`${idBase}-combined`}
        />
      )}
    </div>
  );
}
