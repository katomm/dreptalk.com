// The panel's sidebar: what goes on chain, who decides and at what
// threshold, the facts of the action, and the Continue button. While the
// panel is narrower than 880px (a container query on the panel, see
// global.css) the cards flow below the parameters, and the action block is
// pinned to the bottom of the screen while its own place here is still below
// it.
import type { RefObject } from 'react';
import {
  PARAM_DEFS,
  formatParamValue,
  groupLabel,
  parseParamInput,
  type ParamKey,
  type ParamValues,
} from '@/lib/governance/paramDefs.js';
import type { DepositState, ParamChangePanelState } from '@/lib/governance/govActionFormState.js';
import { EPOCH_LENGTH_SECONDS } from '@/lib/config/network.js';
import { formatAdaPlain } from '@/lib/format/ada.js';
import { shortenHash } from '@/lib/governance/onchain.js';

export interface ParamSummaryProps {
  value: ParamChangePanelState;
  current: ParamValues;
  errors: Partial<Record<ParamKey, string>>;
  /** DRep threshold in percent for the picked groups, null while unknown. */
  drepPct: number | null;
  ccQuorum: { numerator: number; denominator: number } | null;
  deposit: DepositState;
  govActionLifetime: number | null;
  /** The guardrails script hash the action will carry, null when the chain has none. */
  guardrailHash: string | null;
  /** Why Continue is not available, null when it is ready or when the reason is shown elsewhere. */
  reason: string | null;
  canContinue: boolean;
  onContinue: () => void;
  /**
   * Marks the action block's place in the summary, the panel watches it to dock the block on narrow
   * screens.
   */
  actionSlotRef?: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
}

function depositText(deposit: DepositState): string {
  if (deposit.status === 'loading') return 'loading';
  if (deposit.status === 'error') return 'unavailable';
  return `${formatAdaPlain(deposit.lovelace)} tADA, refunded`;
}

function windowText(lifetime: number | null): string {
  if (lifetime === null) return 'loading';
  const days = Math.round((lifetime * EPOCH_LENGTH_SECONDS) / 86_400);
  return `${lifetime} epoch${lifetime === 1 ? '' : 's'}, about ${days} days`;
}

export default function ParamSummary({
  value,
  current,
  errors,
  drepPct,
  ccQuorum,
  deposit,
  govActionLifetime,
  guardrailHash,
  reason,
  canContinue,
  onContinue,
  actionSlotRef,
  disabled = false,
}: ParamSummaryProps) {
  const { picked } = value;
  const ccPct = ccQuorum && ccQuorum.denominator > 0 ? (ccQuorum.numerator / ccQuorum.denominator) * 100 : null;
  // No count before anything is picked, the card above already asks for a parameter.
  const count = picked.length ? `${picked.length} change${picked.length === 1 ? '' : 's'}` : null;

  return (
    <aside className="pcp-side" aria-label="Summary">
      <div className="pcp-scard">
        <p className="pcp-scard__title">On-chain changes</p>
        {picked.length === 0 ? (
          <p className="pcp-scard__empty">Pick a parameter to start.</p>
        ) : (
          picked.map((key) => {
            const def = PARAM_DEFS[key];
            const parsed = parseParamInput(key, value.inputs[key] ?? '');
            const now = current[key];
            return (
              <div key={key} className="pcp-ocx" data-state={errors[key] ? 'invalid' : 'ok'}>
                <span>
                  <span className="pcp-ocx__grp">{groupLabel(key)}</span>
                  <span className="pcp-ocx__name">{def.short}</span>
                </span>
                <span className="pcp-ocx__val">
                  {now && <span className="pcp-ocx__old">{formatParamValue(key, now)}</span>}
                  <span className="pcp-ocx__new">{parsed.ok ? formatParamValue(key, parsed.value) : '?'}</span>
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="pcp-scard">
        <p className="pcp-scard__title">Who decides</p>
        <div className="pcp-who">
          <span>DReps</span>
          <b>{drepPct === null ? 'unknown' : `${drepPct}% yes`}</b>
        </div>
        <div className="pcp-thr" aria-hidden="true">
          {drepPct !== null && <i style={{ left: `${drepPct}%` }} />}
        </div>
        <div className="pcp-who">
          <span>Constitutional Committee</span>
          <b>{ccQuorum ? `${ccQuorum.numerator}/${ccQuorum.denominator} yes` : 'unknown'}</b>
        </div>
        <div className="pcp-thr" aria-hidden="true">
          {ccPct !== null && <i style={{ left: `${ccPct}%` }} />}
        </div>
        <div className="pcp-kv">
          <span>Stake pools</span>
          <span>do not vote on these</span>
        </div>
      </div>

      <div className="pcp-scard pcp-scard--facts">
        <div className="pcp-kv">
          <span>Voting window</span>
          <span>{windowText(govActionLifetime)}</span>
        </div>
        <div className="pcp-kv">
          <span>Takes effect</span>
          <span>one epoch after it passes</span>
        </div>
        <div className="pcp-kv">
          <span>Deposit</span>
          <span>{depositText(deposit)}</span>
        </div>
        {guardrailHash && (
          <div className="pcp-kv">
            <span>Guardrails script</span>
            <span className="pcp-mono" title={guardrailHash}>
              {shortenHash(guardrailHash)}
            </span>
          </div>
        )}
      </div>

      <div ref={actionSlotRef} className="pcp-action-slot" aria-hidden="true" />
      <div className="pcp-action">
        <div className="pcp-action__status">
          {count && <span className="pcp-action__count">{count}</span>}
          {reason ? (
            <p className="pcp-action__reason">{reason}</p>
          ) : (
            canContinue && <p className="pcp-action__ready">Ready</p>
          )}
        </div>
        <button type="button" className="pcp-btn" disabled={disabled || !canContinue} onClick={onContinue}>
          Continue to rationale
        </button>
      </div>
    </aside>
  );
}
