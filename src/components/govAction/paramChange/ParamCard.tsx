// One picked parameter: the value in force, the new value, the constitution's
// range with both values on it, the field error and the live impact.
// Presentational, the panel parses and validates.
import {
  PARAM_DEFS,
  formatParamValue,
  parseParamInput,
  type ParamKey,
} from '@/lib/governance/paramDefs.js';
import { compareRational, formatLovelaceExact, formatRationalDecimal, rationalToNumber, reduce, type Rational } from '@/lib/format/rational.js';
import type { ModelParams } from '@/lib/governance/paramImpact.js';
import type { PoolEconomicsState } from './ParamChangePanel.js';
import ImpactSaturation from './ImpactSaturation.js';
import ImpactRewards from './ImpactRewards.js';
import ImpactMinPoolCost from './ImpactMinPoolCost.js';
import ImpactBudget from './ImpactBudget.js';

export interface ParamCardProps {
  paramKey: ParamKey;
  raw: string;
  /** The value in force, null when the chain did not report it. */
  current: Rational | null;
  /** The field error, undefined while the value can go on chain or nothing is typed. */
  error: string | undefined;
  economics: PoolEconomicsState;
  onRetryEconomics: () => void;
  /** The impact model before and after, built from every valid picked value. Null when it cannot be built. */
  model: { from: ModelParams; to: ModelParams } | null;
  /** Whether a0 is picked too: then the rewards chart lives on the a0 card. */
  a0Picked: boolean;
  /** Whether k and a0 both change, for the rewards chart legend. */
  kAndA0: boolean;
  onInput: (raw: string) => void;
  onRemove: () => void;
  disabled?: boolean;
}

/** The signed difference in the unit the field is typed in. */
function deltaLabel(key: ParamKey, next: Rational, current: Rational): string {
  const cmp = compareRational(next, current);
  if (cmp === 0) return 'unchanged';
  const sign = cmp > 0 ? '+' : '-';
  const diff = reduce({ n: (next.n * current.d - current.n * next.d) * BigInt(cmp), d: next.d * current.d });
  const input = PARAM_DEFS[key].input;
  if (input === 'ada') return `${sign}${formatLovelaceExact(diff.n / diff.d)}`;
  if (input === 'percent') return `${sign}${formatRationalDecimal({ n: diff.n * 100n, d: diff.d })} pp`;
  if (input === 'int') return `${sign}${(diff.n / diff.d).toLocaleString('en-US')}`;
  return `${sign}${formatRationalDecimal(diff)}`;
}

function RangeScale({ paramKey, current, next }: { paramKey: ParamKey; current: Rational | null; next: Rational | null }) {
  const def = PARAM_DEFS[paramKey];
  const min = rationalToNumber(def.min);
  const max = rationalToNumber(def.max);
  const pos = (r: Rational) => Math.max(0, Math.min(100, ((rationalToNumber(r) - min) / (max - min)) * 100));
  const outside = next !== null && (compareRational(next, def.min) < 0 || compareRational(next, def.max) > 0);
  return (
    <div className="pcp-scale">
      <div className="pcp-scale__ok" />
      {current && (
        <div className="pcp-mark pcp-mark--now" style={{ left: `${pos(current)}%` }}>
          <span>now</span>
        </div>
      )}
      {next && (
        <div className="pcp-mark pcp-mark--new" style={{ left: `${pos(next)}%` }}>
          <span>{outside ? 'outside' : 'new'}</span>
        </div>
      )}
      <span className="pcp-scale__end pcp-scale__end--min">{formatParamValue(paramKey, def.min)}</span>
      <span className="pcp-scale__end pcp-scale__end--max">{formatParamValue(paramKey, def.max)}</span>
    </div>
  );
}

type ImpactProps = Pick<ParamCardProps, 'paramKey' | 'current' | 'economics' | 'onRetryEconomics' | 'model' | 'a0Picked' | 'kAndA0'> & { next: Rational };

function Impact({ paramKey, current, next, economics, onRetryEconomics, model, a0Picked, kAndA0 }: ImpactProps) {
  if (economics.status === 'loading') return <p className="pcp-why">Loading pool data...</p>;
  if (economics.status === 'error') {
    return (
      <p className="pcp-why">
        <span>Impact figures are unavailable right now.</span>{' '}
        <button type="button" className="pcp-linkbtn" onClick={onRetryEconomics}>
          Try again
        </button>
      </p>
    );
  }
  if (!model || !current) return null;
  const eco = economics.data;
  switch (paramKey) {
    case 'k':
      return (
        <>
          <ImpactSaturation eco={eco} from={model.from} to={model.to} />
          {!a0Picked && (
            <div className="pcp-impact__more">
              <ImpactRewards eco={eco} from={model.from} to={model.to} together={false} />
            </div>
          )}
        </>
      );
    case 'a0':
      return <ImpactRewards eco={eco} from={model.from} to={model.to} together={kAndA0} />;
    case 'minPoolCost':
      return <ImpactMinPoolCost eco={eco} currentLovelace={current.n / current.d} nextLovelace={next.n / next.d} />;
    case 'rho':
    case 'tau':
      return <ImpactBudget eco={eco} from={model.from} to={model.to} />;
  }
}

export default function ParamCard(props: ParamCardProps) {
  const { paramKey, raw, current, error, onInput, onRemove, disabled = false } = props;
  const def = PARAM_DEFS[paramKey];
  const parsed = parseParamInput(paramKey, raw);
  const next = parsed.ok ? parsed.value : null;
  const unit = def.input === 'ada' ? '₳' : def.input === 'percent' ? '%' : null;
  const state = error ? 'invalid' : 'ok';
  return (
    <fieldset aria-label={def.title} className="pcp-card" data-state={state}>
      <div className="pcp-card__head">
        <div className="pcp-card__name">
          <div className="pcp-card__title">{def.title}</div>
          <div className="pcp-card__key">{def.key === 'minPoolCost' ? def.ledgerKey : `${def.short} · ${def.ledgerKey}`}</div>
        </div>
        <div className="pcp-card__side">
          <span className="pcp-group">{def.group === 'technical' ? 'Technical' : 'Economic'} group</span>
          <button type="button" className="pcp-card__remove" onClick={onRemove} disabled={disabled}>
            Remove
          </button>
        </div>
      </div>

      <div className="pcp-valrow">
        <span className="pcp-old">{current ? formatParamValue(paramKey, current) : 'unknown'}</span>
        <span className="pcp-to" aria-hidden="true">
          →
        </span>
        <span className="pcp-inp">
          <input
            type="text"
            inputMode="decimal"
            aria-label={`New ${def.title}`}
            aria-invalid={error ? true : undefined}
            value={raw}
            onChange={(e) => onInput(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
          />
          {unit && <span className="pcp-inp__unit">{unit}</span>}
        </span>
        {next && current && <span className="pcp-delta">{deltaLabel(paramKey, next, current)}</span>}
      </div>

      <RangeScale paramKey={paramKey} current={current} next={next} />

      {error && (
        <p className="pcp-err" role="alert">
          {error}
        </p>
      )}

      {next && !error && (
        <div className="pcp-impact">
          <p className="pcp-label">Impact</p>
          <Impact
            paramKey={paramKey}
            current={current}
            next={next}
            economics={props.economics}
            onRetryEconomics={props.onRetryEconomics}
            model={props.model}
            a0Picked={props.a0Picked}
            kAndA0={props.kAndA0}
          />
        </div>
      )}
    </fieldset>
  );
}
