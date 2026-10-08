// ParameterChange panel: the previous action, the parameter chips, one card
// per picked parameter with its live impact, an Add row per parameter not
// picked, and the summary with the Continue button. Presentational, the
// rules live in paramDefs.ts and govActionFormState.ts, the impact model in
// paramImpact.ts. The island owns the pool data fetch and passes its state.
import { useEffect, useRef, useState, type RefObject } from 'react';
import PrevActionField from '../PrevActionField.js';
import { InfoIcon } from '../icons.js';
import ParamCard from './ParamCard.js';
import ParamSummary from './ParamSummary.js';
import {
  PARAM_DEFS,
  PARAM_KEYS,
  formatParamValue,
  parseParamInput,
  scopeForKeys,
  valuesFromJson,
  type ParamKey,
  type ParamValues,
} from '@/lib/governance/paramDefs.js';
import { modelParams, type PoolEconomics } from '@/lib/governance/paramImpact.js';
import {
  paramFieldErrors,
  validateParamChangePanel,
  type DepositState,
  type ParamChangePanelState,
} from '@/lib/governance/govActionFormState.js';
import { guardrailDecision } from '@/lib/governance/guardrailScript.js';
import { drepThresholdPct } from '@/lib/governance/thresholds.js';
import type { ActionContextResponse } from '@/lib/governance/actionContextHandler.js';
import type { ProtocolParams } from '@/lib/db/protocolParams.js';
import type { NetworkConfig } from '@/lib/config/network.js';

export type PoolEconomicsState = { status: 'loading' } | { status: 'ready'; data: PoolEconomics } | { status: 'error' };

export interface ParamChangePanelProps {
  value: ParamChangePanelState;
  onChange: (value: ParamChangePanelState) => void;
  context: ActionContextResponse;
  economics: PoolEconomicsState;
  onRetryEconomics: () => void;
  protocolParams: ProtocolParams | null;
  ccQuorum: { numerator: number; denominator: number } | null;
  deposit: DepositState;
  govActionLifetime: number | null;
  networkConfig: NetworkConfig;
  onContinue: () => void;
  disabled?: boolean;
}

// The docked action bar's height, the --pcp-dock-h of global.css.
const DOCK_HEIGHT_PX = 80;
// The panel width from which the summary sits next to the cards, the
// @container pcp-panel breakpoint of global.css. Below it the layout is one
// column and the action block docks.
const TWO_COLUMN_MIN_PX = 880;

/**
 * Whether the action block's own place in the summary is still below the
 * screen. Only then is the block pinned to the bottom edge (narrow screens,
 * see global.css). Once the place scrolls into view, or above it because the
 * user moved on to the fields below the panel, the block scrolls with the
 * page. The bar's height is taken off the screen, so the pinned bar hands
 * over to the inline block exactly where the block takes its place.
 *
 * Only in the one-column layout (panel narrower than TWO_COLUMN_MIN_PX):
 * next to the cards the summary is sticky and never needs to dock.
 *
 * Measured on scroll, resize and panel size changes, once per frame. An
 * IntersectionObserver is not enough: it reports crossings only, and a jump
 * from below the panel straight to its top (a fling, Home, a focus jump)
 * crosses nothing, which left the bar undocked at the top of the page.
 */
function useDockedAction(panelRef: RefObject<HTMLDivElement | null>) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const panel = panelRef.current;
      const box = panel?.getBoundingClientRect();
      const oneColumn = !box || box.width < TWO_COLUMN_MIN_PX;
      setDocked(oneColumn && slot.getBoundingClientRect().top > window.innerHeight - DOCK_HEIGHT_PX);
      // The docked bar spans the screen, its content lines up with the panel.
      if (panel && box) {
        panel.style.setProperty('--pcp-dock-l', `${Math.max(0, Math.round(box.left))}px`);
        panel.style.setProperty('--pcp-dock-r', `${Math.max(0, Math.round(document.documentElement.clientWidth - box.right))}px`);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Cards added or removed, the Advanced disclosure, charts arriving: all move the slot without a scroll.
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (resize && panelRef.current) resize.observe(panelRef.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      resize?.disconnect();
    };
  }, [panelRef]);
  return { slotRef, docked };
}

export default function ParamChangePanel({
  value,
  onChange,
  context,
  economics,
  onRetryEconomics,
  protocolParams,
  ccQuorum,
  deposit,
  govActionLifetime,
  networkConfig,
  onContinue,
  disabled = false,
}: ParamChangePanelProps) {
  const prevContext = context.prev ?? { lastEnacted: null, open: [] };
  const competing = prevContext.open.filter((row) => row.type === 'ParameterChange');
  const current = valuesFromJson(context.params);
  const errors = paramFieldErrors(value, context);
  const validation = validateParamChangePanel(value, context);
  const guardrail = guardrailDecision(context.guardrail);

  // The live impact reads every picked value that can go on chain. A value
  // with a field error stays out, so one bad field never skews another card.
  const next: ParamValues = {};
  for (const key of value.picked) {
    if (errors[key]) continue;
    const parsed = parseParamInput(key, value.inputs[key] ?? '');
    if (parsed.ok) next[key] = parsed.value;
  }
  const model = modelParams(current, next);
  const panelRef = useRef<HTMLDivElement>(null);
  const { slotRef, docked } = useDockedAction(panelRef);
  const picked = PARAM_KEYS.filter((key) => value.picked.includes(key));
  const unpicked = PARAM_KEYS.filter((key) => !value.picked.includes(key));
  const drepPct = drepThresholdPct('ParameterChange', protocolParams, scopeForKeys(picked));
  // The island already shows the guardrail problem, the summary does not repeat it.
  const reason = !validation.ok && guardrail.ok ? validation.error : null;

  const toggle = (key: ParamKey) => {
    const on = value.picked.includes(key);
    onChange({ ...value, picked: PARAM_KEYS.filter((k) => (k === key ? !on : value.picked.includes(k))) });
  };

  return (
    <div ref={panelRef} className="pcp-panel" data-docked={docked ? 'true' : 'false'}>
      <div className="pcp-grid">
        <div className="pcp-main">
          {competing.map((row) => (
            <div key={`${row.txHash}#${row.index}`} className="callout callout--info">
              <InfoIcon />
              <div className="callout__body">
                <p className="pcp-callout__text">
                  Another parameter change is open: {row.title ?? `${row.id.slice(0, 16)}...`}. Both build on the same
                  previous change, so only one of them can take effect.
                </p>
                <a href={`/ga/${row.id}/`}>View the open proposal</a>
              </div>
            </div>
          ))}

          <PrevActionField
            context={prevContext}
            value={value.prev}
            onChange={(prev) => onChange({ ...value, prev })}
            networkConfig={networkConfig}
            disabled={disabled}
          />

          <div>
            <p className="pcp-label">Parameters to change</p>
            <div className="pcp-chips">
              {PARAM_KEYS.map((key) => {
                const on = value.picked.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    className="pcp-chip"
                    aria-pressed={on}
                    data-state={on && errors[key] ? 'invalid' : 'ok'}
                    title={PARAM_DEFS[key].title}
                    onClick={() => toggle(key)}
                    disabled={disabled}
                  >
                    {PARAM_DEFS[key].short}
                  </button>
                );
              })}
            </div>
          </div>

          {picked.map((key) => (
            <ParamCard
              key={key}
              paramKey={key}
              raw={value.inputs[key] ?? ''}
              current={current[key] ?? null}
              error={errors[key]}
              economics={economics}
              onRetryEconomics={onRetryEconomics}
              model={model}
              a0Picked={picked.includes('a0')}
              kAndA0={next.k !== undefined && next.a0 !== undefined}
              onInput={(raw) => onChange({ ...value, inputs: { ...value.inputs, [key]: raw } })}
              onRemove={() => toggle(key)}
              disabled={disabled}
            />
          ))}

          {unpicked.map((key) => {
            const now = current[key];
            return (
              <div key={key} className="pcp-addrow">
                <span>
                  <b>{PARAM_DEFS[key].title}</b>
                  {now && <span className="pcp-addrow__now"> · {formatParamValue(key, now)}</span>}
                </span>
                <button type="button" aria-label={`Add ${PARAM_DEFS[key].title}`} onClick={() => toggle(key)} disabled={disabled}>
                  Add
                </button>
              </div>
            );
          })}
        </div>

        <ParamSummary
          value={value}
          current={current}
          errors={errors}
          drepPct={drepPct}
          ccQuorum={ccQuorum}
          deposit={deposit}
          govActionLifetime={govActionLifetime}
          guardrailHash={context.guardrail?.state === 'known' ? context.guardrail.scriptHash : null}
          reason={reason}
          canContinue={validation.ok}
          onContinue={onContinue}
          actionSlotRef={slotRef}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
