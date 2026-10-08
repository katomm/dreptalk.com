// ParameterChange panel: the previous action, the parameter chips, one card
// per picked parameter with its live impact, an Add row per parameter not
// picked, and the summary with the Continue button. Presentational, the
// rules live in paramDefs.ts and govActionFormState.ts, the impact model in
// paramImpact.ts. The island owns the pool data fetch and passes its state.
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import PrevActionField from '../PrevActionField.js';
import { InfoIcon } from '../icons.js';
import ParamCard, { EconomicsPending } from './ParamCard.js';
import ImpactRewards, { type RewardBasis } from './ImpactRewards.js';
import { DataSource } from './chart.js';
import ParamSummary from './ParamSummary.js';
import {
  PARAM_DEFS,
  PARAM_KEYS,
  formatParamValue,
  scopeForKeys,
  valuesFromJson,
  type ParamKey,
  type ParamValues,
} from '@/lib/governance/paramDefs.js';
import { modelParams, REWARD_KEYS, type ModelParams, type PoolEconomics } from '@/lib/governance/paramImpact.js';
import {
  paramFieldErrors,
  validateParamChangePanel,
  validParamValues,
  type DepositState,
  type ParamChangePanelState,
} from '@/lib/governance/govActionFormState.js';
import { guardrailDecision } from '@/lib/governance/guardrailScript.js';
import { matchesRef } from '@/lib/governance/prevAction.js';
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
    let dockL = '';
    let dockR = '';
    const measure = () => {
      frame = 0;
      const panel = panelRef.current;
      const box = panel?.getBoundingClientRect();
      const oneColumn = !box || box.width < TWO_COLUMN_MIN_PX;
      setDocked(oneColumn && slot.getBoundingClientRect().top > window.innerHeight - DOCK_HEIGHT_PX);
      // The docked bar spans the screen, its content lines up with the panel.
      // Written only on a change, a scroll alone does not move the panel sideways.
      if (panel && box) {
        const l = `${Math.max(0, Math.round(box.left))}px`;
        const r = `${Math.max(0, Math.round(document.documentElement.clientWidth - box.right))}px`;
        if (l !== dockL) {
          dockL = l;
          panel.style.setProperty('--pcp-dock-l', l);
        }
        if (r !== dockR) {
          dockR = r;
          panel.style.setProperty('--pcp-dock-r', r);
        }
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

type ImpactModel = { from: ModelParams; to: ModelParams } | null;

/**
 * The impact model with a stable identity: modelParams builds new objects on
 * every render, this keeps the previous ones until one of the eight numbers
 * changes, so the memoized charts skip a render for an edit elsewhere.
 */
function useStableModel(model: ImpactModel): ImpactModel {
  const ready = model !== null;
  const { k: kFrom, a0: a0From, rho: rhoFrom, tau: tauFrom } = model?.from ?? {};
  const { k: kTo, a0: a0To, rho: rhoTo, tau: tauTo } = model?.to ?? {};
  return useMemo(
    () =>
      ready
        ? {
            from: { k: kFrom!, a0: a0From!, rho: rhoFrom!, tau: tauFrom! },
            to: { k: kTo!, a0: a0To!, rho: rhoTo!, tau: tauTo! },
          }
        : null,
    [ready, kFrom, a0From, rhoFrom, tauFrom, kTo, a0To, rhoTo, tauTo],
  );
}

/**
 * The picked reward parameter changes with a valid value, formatted for the
 * rewards chart caption. Keyed by its content, so the memoized chart keeps
 * its props while an unrelated field changes.
 */
function useRewardBasis(keys: readonly ParamKey[], current: ParamValues, next: ParamValues): readonly RewardBasis[] {
  const list: RewardBasis[] = [];
  for (const key of keys) {
    const from = current[key];
    const to = next[key];
    if (from && to) list.push({ short: PARAM_DEFS[key].short, from: formatParamValue(key, from), to: formatParamValue(key, to) });
  }
  const json = JSON.stringify(list);
  return useMemo(() => JSON.parse(json) as RewardBasis[], [json]);
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
  // An open parameter change the user builds on is the chain this action
  // extends, so only the others compete with it.
  const competing = prevContext.open.filter(
    (row) => row.type === 'ParameterChange' && !(value.prev && matchesRef(value.prev, row)),
  );
  const current = useMemo(() => valuesFromJson(context.params), [context.params]);
  const errors = paramFieldErrors(value, context);
  const validation = validateParamChangePanel(value, context);
  const guardrail = guardrailDecision(context.guardrail);

  // The live impact reads every picked value that can go on chain. A value
  // with a field error stays out, so one bad field never skews another card.
  const next = validParamValues(value, current);
  const model = useStableModel(modelParams(current, next));
  const panelRef = useRef<HTMLDivElement>(null);
  const { slotRef, docked } = useDockedAction(panelRef);
  const { picked } = value;
  const unpicked = PARAM_KEYS.filter((key) => !value.picked.includes(key));
  // The rewards chart reads k, a0, rho and tau together. With two or more of
  // them picked it moves out of the cards into one combined section, with one
  // it stays on the k or a0 card.
  const rewardKeys = picked.filter((key) => (REWARD_KEYS as readonly ParamKey[]).includes(key));
  const combined = rewardKeys.length >= 2;
  const rewardsHost = rewardKeys.length === 1 && (rewardKeys[0] === 'k' || rewardKeys[0] === 'a0') ? rewardKeys[0] : null;
  const rewardBasis = useRewardBasis(rewardKeys, current, next);
  const combinedId = useId();
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
                  Another parameter change is open: {row.title ?? `${row.id.slice(0, 16)}...`}. Only one parameter
                  change can take effect from the same previous action. If that one is enacted first, this one can no
                  longer pass.
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
                // Color alone would hide the invalid state from some readers, so it also shows "!" and names it.
                const invalid = on && Boolean(errors[key]);
                return (
                  <button
                    key={key}
                    type="button"
                    className="pcp-chip"
                    aria-pressed={on}
                    aria-label={invalid ? `${PARAM_DEFS[key].short}, value not valid` : undefined}
                    data-state={invalid ? 'invalid' : 'ok'}
                    title={PARAM_DEFS[key].title}
                    onClick={() => toggle(key)}
                    disabled={disabled}
                  >
                    {PARAM_DEFS[key].short}
                    {invalid && (
                      <span className="pcp-chip__mark" aria-hidden="true">
                        !
                      </span>
                    )}
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
              rewards={combined ? 'combined' : rewardsHost === key ? 'here' : null}
              rewardBasis={rewardBasis}
              network={networkConfig.network}
              onInput={(raw) => onChange({ ...value, inputs: { ...value.inputs, [key]: raw } })}
              onRemove={() => toggle(key)}
              disabled={disabled}
            />
          ))}

          {combined && rewardBasis.length > 0 && (
            <section className="pcp-card pcp-combined" aria-labelledby={combinedId}>
              <h3 id={combinedId} className="pcp-card__title pcp-combined__title">
                Combined impact of this proposal
              </h3>
              <div className="pcp-impact">
                {economics.status === 'ready' && model ? (
                  <>
                    <ImpactRewards eco={economics.data} from={model.from} to={model.to} basis={rewardBasis} />
                    <DataSource network={networkConfig.network} epoch={economics.data.epoch} />
                  </>
                ) : (
                  <EconomicsPending economics={economics} onRetry={onRetryEconomics} />
                )}
              </div>
            </section>
          )}

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
