// What the impact charts are built from: the model before and after, the
// rewards chart caption and where the rewards chart goes. Shared by the
// builder panel and the proposal page.
import { useMemo, useRef } from 'react';
import { PARAM_DEFS, formatParamValue, type ParamKey, type ParamValues } from '@/lib/governance/paramDefs.js';
import { modelParams, REWARD_KEYS, type ModelParams } from '@/lib/governance/paramImpact.js';
import type { RewardBasis } from './ImpactRewards.js';

type RewardsHost = 'k' | 'a0' | null;
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
 * The rewards chart caption entry for one reward parameter, null unless it has a valid new value.
 */
function basisEntry(key: ParamKey, current: ParamValues, next: ParamValues): RewardBasis | null {
  const from = current[key];
  const to = next[key];
  return from && to ? { short: PARAM_DEFS[key].short, from: formatParamValue(key, from), to: formatParamValue(key, to) } : null;
}

/**
 * The picked reward parameter changes with a valid value, formatted for the
 * rewards chart caption, in the order of REWARD_KEYS (the chip order). Rebuilt
 * only when one of the formatted values changes, so the memoized chart keeps
 * its props while an unrelated field changes.
 */
function useRewardBasis(current: ParamValues, next: ParamValues): readonly RewardBasis[] {
  const list = REWARD_KEYS.map((key) => basisEntry(key, current, next)).filter((e): e is RewardBasis => e !== null);
  const signature = list.map((e) => `${e.short}|${e.from}|${e.to}`).join(';');
  const stable = useRef({ signature, list });
  if (stable.current.signature !== signature) stable.current = { signature, list };
  return stable.current.list;
}

/**
 * The rewards chart reads k, a0, rho and tau together. With two or more of
 * them holding a valid value it moves out of the cards into one combined
 * section, with one it stays on the k or a0 card. A picked chip without a
 * value yet does not count, so the chart stays put until a value is typed.
 */
export function impactPlacement(next: ParamValues): { combined: boolean; rewardsHost: RewardsHost } {
  const rewardKeys = REWARD_KEYS.filter((key) => next[key]);
  const combined = rewardKeys.length >= 2;
  const only = rewardKeys.length === 1 ? rewardKeys[0] : null;
  return { combined, rewardsHost: only === 'k' || only === 'a0' ? only : null };
}

/**
 * Everything the impact charts need for one set of changes. `next` holds only the values that can
 * go on chain, so one bad field never skews another chart.
 */
export function useImpactPlan(
  current: ParamValues,
  next: ParamValues,
): {
  model: ImpactModel;
  rewardBasis: readonly RewardBasis[];
  combined: boolean;
  rewardsHost: RewardsHost;
} {
  const model = useStableModel(modelParams(current, next));
  const rewardBasis = useRewardBasis(current, next);
  return { model, rewardBasis, ...impactPlacement(next) };
}
