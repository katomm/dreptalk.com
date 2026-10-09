// Wording for the build failures the guardrail-checked types (treasury
// withdrawal, parameter change) add to the submit flow: the guardrail
// evaluation and the collateral a Plutus check needs.
// Leaf module, the island keeps its CIP-30 error reader for everything else.
// The collateral checks match the SDK's plain error messages
// (sdk/builders/phases/Collateral.ts), the only signal it gives, so a
// rewording upstream falls through to the generic reader instead of breaking.
import type { EvaluationFailureCause } from './evaluateContract.js';
import type { GovActionFormType } from './prevAction.js';

export const COLLATERAL_SELECTION_MESSAGE =
  'Your wallet needs about 5 ada in plain-ada UTxOs that can serve as collateral.';
export const COLLATERAL_TOKENS_MESSAGE =
  "Your wallet's UTxOs carry too many tokens to serve as collateral. Send about 5 ada to it as a separate payment and try again.";
export const EVALUATION_FAILED_MESSAGE = "The constitution's guardrails script rejected this withdrawal.";
export const PARAM_EVALUATION_FAILED_MESSAGE = "The constitution's guardrails script rejected this parameter change.";
export const UNSUPPORTED_PARAMETER_CHANGE_MESSAGE =
  "DRepTalk only submits changes to k, a0, minPoolCost, rho and tau within the constitution's limits.";
// The author witness may already exist at this point, so the sentence only
// speaks about the transaction.
export const EVALUATOR_UNAVAILABLE_MESSAGE = 'Could not reach the script evaluator. No transaction was signed.';

export interface MappedBuildError {
  message: string;
  /** The script error as Ogmios reported it, for a disclosure under the message. */
  detail: string | null;
}

function isFailureCause(value: unknown): value is EvaluationFailureCause {
  const code = (value as { code?: unknown } | null)?.code;
  return code === 'evaluation_failed' || code === 'evaluator_unavailable' || code === 'unsupported_parameter_change';
}

/** The adapter's cause, found by walking the cause chain a few levels deep. */
function findFailureCause(err: unknown): EvaluationFailureCause | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    if (isFailureCause(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The sentence for a rejected guardrail evaluation, per type. Any type not listed gets the treasury wording. */
const EVALUATION_FAILED_BY_TYPE: Partial<Record<GovActionFormType, string>> = {
  TreasuryWithdrawals: EVALUATION_FAILED_MESSAGE,
  ParameterChange: PARAM_EVALUATION_FAILED_MESSAGE,
};

/** The submit form's wording for a guardrail or collateral failure, or null for any other error. */
export function mapGuardrailBuildError(err: unknown, type: GovActionFormType): MappedBuildError | null {
  const failed = EVALUATION_FAILED_BY_TYPE[type] ?? EVALUATION_FAILED_MESSAGE;
  const cause = findFailureCause(err);
  if (cause?.code === 'evaluation_failed') return { message: failed, detail: cause.detail };
  if (cause?.code === 'unsupported_parameter_change') return { message: UNSUPPORTED_PARAMETER_CHANGE_MESSAGE, detail: null };
  if (cause?.code === 'evaluator_unavailable') return { message: EVALUATOR_UNAVAILABLE_MESSAGE, detail: null };
  const raw = err instanceof Error ? err.message : '';
  if (/\bevaluation_failed\b/.test(raw)) return { message: failed, detail: null };
  if (/\bunsupported_parameter_change\b/.test(raw)) return { message: UNSUPPORTED_PARAMETER_CHANGE_MESSAGE, detail: null };
  if (/\bevaluator_unavailable\b/.test(raw)) return { message: EVALUATOR_UNAVAILABLE_MESSAGE, detail: null };
  if (/No suitable UTxOs available for collateral|Insufficient collateral available/.test(raw)) {
    return { message: COLLATERAL_SELECTION_MESSAGE, detail: null };
  }
  if (/Collateral return \(\d+ lovelace\) is below minimum UTxO requirement/.test(raw)) {
    return { message: COLLATERAL_TOKENS_MESSAGE, detail: null };
  }
  return null;
}

/**
 * Whether a submit error says the previous governance action no longer fits
 * the chain. Matches the ledger's Conway failure name and Ogmios' wording of
 * it (submit error 3159, field invalidOrMissingPreviousProposals, seen on a
 * devnet), so it works when the form built on a null root too, and the
 * chosen tx hash as before.
 */
export function isStalePrevError(raw: string, prevTxHashHex: string | null): boolean {
  if (/InvalidPrevGovActionId|PrevGovActionId|invalidOrMissingPreviousProposals/i.test(raw)) return true;
  return prevTxHashHex !== null && raw.toLowerCase().includes(prevTxHashHex.toLowerCase());
}
