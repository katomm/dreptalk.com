// One picked parameter: the value in force, the new value, the constitution's
// range with both values on it, the field error and the live impact.
// Presentational, the panel parses and validates.
import {
  PARAM_DEFS,
  formatParamValue,
  groupLabel,
  parseParamInput,
  type ParamKey,
} from '@/lib/governance/paramDefs.js';
import { compareRational, formatLovelaceExact, formatRationalDecimal, rationalToNumber, reduce, type Rational } from '@/lib/format/rational.js';
import type { ModelParams } from '@/lib/governance/paramImpact.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import type { PoolEconomicsState } from './usePoolEconomics.js';
import type { RewardBasis } from './ImpactRewards.js';
import ParamImpact from './ParamImpact.js';
import { InfoIcon } from '../icons.js';
import { CONSULTATION_DAYS } from '@/lib/governance/consultation.js';

export interface ParamCardProps {
  paramKey: ParamKey;
  raw: string;
  /** The value in force, null when the chain did not report it. */
  current: Rational | null;
  /** The field error, undefined while the value can go on chain or nothing is typed. */
  error: string | undefined;
  economics: PoolEconomicsState;
  onRetryEconomics: () => void;
  /**
   * The impact model before and after, built from every valid picked value. Null when it cannot be
   * built.
   */
  model: { from: ModelParams; to: ModelParams } | null;
  /**
   * Where the rewards chart goes: on this card, in the combined section below the cards, or nowhere
   * for this card.
   */
  rewards: 'here' | 'combined' | null;
  /** The picked reward parameter changes the rewards chart is calculated with. */
  rewardBasis: readonly RewardBasis[];
  network: CardanoNetwork;
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
  if (input === 'lovelace') return `${sign}${formatParamValue(key, diff)}`;
  return `${sign}${formatRationalDecimal(diff)}`;
}

function RangeScale({ paramKey, current, next }: { paramKey: ParamKey; current: Rational | null; next: Rational | null }) {
  const def = PARAM_DEFS[paramKey];
  const min = rationalToNumber(def.min);
  const max = rationalToNumber(def.max);
  const pos = (r: Rational) => Math.max(0, Math.min(100, ((rationalToNumber(r) - min) / (max - min)) * 100));
  const outside = next !== null && (compareRational(next, def.min) < 0 || compareRational(next, def.max) > 0);
  return (
    <div className={def.input === 'lovelace' ? 'pcp-scale pcp-scale--unit' : 'pcp-scale'}>
      <div className="pcp-scale__ok" />
      {current && (
        <div className="pcp-mark pcp-mark--now" style={{ left: `${pos(current)}%` }}>
          <span className="pcp-marklabel">now</span>
        </div>
      )}
      {next && (
        <div className="pcp-mark pcp-mark--new" style={{ left: `${pos(next)}%` }}>
          <span className="pcp-marklabel">{outside ? 'outside' : 'new'}</span>
        </div>
      )}
      <span className="pcp-scale__end pcp-scale__end--min">{formatParamValue(paramKey, def.min)}</span>
      <span className="pcp-scale__end pcp-scale__end--max">{formatParamValue(paramKey, def.max)}</span>
    </div>
  );
}

export default function ParamCard({ raw, error, onInput, onRemove, disabled = false, ...impact }: ParamCardProps) {
  const { paramKey, current } = impact;
  const def = PARAM_DEFS[paramKey];
  const parsed = parseParamInput(paramKey, raw);
  const next = parsed.ok ? parsed.value : null;
  const unit = def.input === 'ada' ? '₳' : def.input === 'percent' ? '%' : null;
  return (
    <fieldset aria-label={def.title} className="pcp-card" data-state={error ? 'invalid' : 'ok'}>
      <div className="pcp-card__head">
        <div className="pcp-card__name">
          <div className="pcp-card__title">{def.title}</div>
          <div className="pcp-card__key">{def.listByTitle ? def.ledgerKey : `${def.short} · ${def.ledgerKey}`}</div>
        </div>
        <div className="pcp-card__side">
          <span className="pcp-group">{groupLabel(paramKey)} group</span>
          {def.security && <span className="pcp-group">Stake pools vote</span>}
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
        {def.input === 'lovelace' && next && (
          <span className="pcp-inp__hint">{formatLovelaceExact(next.n / next.d)} per byte</span>
        )}
        {next && current && <span className="pcp-delta">{deltaLabel(paramKey, next, current)}</span>}
      </div>

      <RangeScale paramKey={paramKey} current={current} next={next} />

      {def.consultation && (
        <div className="callout callout--info">
          <InfoIcon />
          <div className="callout__body">
            <p className="pcp-callout__text">
              The constitution asks that at least {CONSULTATION_DAYS} days normally pass between publishing an off-chain
              proposal for this parameter and submitting it on chain (<span className="pcp-nowrap">{def.consultation}</span>). Start a discussion in{' '}
              <a href="/c/proposal-drafts/">Proposal Drafts</a> and link it in the next step.
            </p>
          </div>
        </div>
      )}

      {error && (
        <p className="pcp-err" role="alert">
          {error}
        </p>
      )}

      {next && !error && (
        <div className="pcp-impact">
          <p className="pcp-label">Impact</p>
          <ParamImpact {...impact} next={next} />
        </div>
      )}
    </fieldset>
  );
}
