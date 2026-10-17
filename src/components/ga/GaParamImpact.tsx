// The impact of a parameter change on the proposal page: a closed section
// that loads the builder's charts and the pool data on its first open.
import { lazy, Suspense, useId, useState } from 'react';
import { PARAM_DEFS, type ParamKey, type ParamValuesJson } from '@/lib/governance/paramDefs.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { usePoolEconomics } from '@/components/govAction/paramChange/usePoolEconomics.js';

const GaParamImpactCharts = lazy(() => import('./GaParamImpactCharts.js'));

export interface GaParamImpactProps {
  network: CardanoNetwork;
  /** The proposed parameters to show, in display order. */
  keys: ParamKey[];
  current: ParamValuesJson;
  proposed: ParamValuesJson;
}

export default function GaParamImpact({ network, keys, current, proposed }: GaParamImpactProps) {
  const [expanded, setExpanded] = useState(false);
  // Set on the first open and kept: closing hides the charts, so the loaded
  // chunk and pool data stay and a reopen sends no request.
  const [everOpened, setEverOpened] = useState(false);
  // The minimum ada chart reads no pool data.
  const { economics, retry } = usePoolEconomics(
    '/api/pool-economics',
    everOpened && keys.some((k) => k !== 'utxoCostPerByte'),
  );
  const bodyId = useId();

  const toggle = () => {
    setExpanded(!expanded);
    setEverOpened(true);
  };

  return (
    <section className="ga-impact">
      <button type="button" className="ga-impact__toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={toggle}>
        Impact of these changes
      </button>
      {!expanded && <p className="ga-impact__closed">{keys.map((key) => PARAM_DEFS[key].title).join(', ')}</p>}
      <div id={bodyId} className="ga-impact__body" hidden={!expanded}>
        {everOpened && (
          <Suspense fallback={<p className="ga-impact__loading">Loading...</p>}>
            <GaParamImpactCharts
              network={network}
              keys={keys}
              current={current}
              proposed={proposed}
              economics={economics}
              onRetry={retry}
            />
          </Suspense>
        )}
      </div>
    </section>
  );
}
