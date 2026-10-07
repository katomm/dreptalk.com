// Wording for the build failures a treasury withdrawal adds to the submit
// flow: the guardrail evaluation and the collateral a Plutus check needs.
// Leaf module, the island keeps its CIP-30 error reader for everything else.
// The collateral checks match the SDK's plain error messages
// (sdk/builders/phases/Collateral.ts), the only signal it gives, so a
// rewording upstream falls through to the generic reader instead of breaking.
import type { EvaluationFailureCause } from './evaluateContract.js';

export const COLLATERAL_SELECTION_MESSAGE =
  'Your wallet needs about 5 ada in plain-ada UTxOs that can serve as collateral.';
export const COLLATERAL_TOKENS_MESSAGE =
  "Your wallet's UTxOs carry too many tokens to serve as collateral. Send about 5 ada to it as a separate payment and try again.";
export const EVALUATION_FAILED_MESSAGE = "The constitution's guardrails script rejected this withdrawal.";
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
  return code === 'evaluation_failed' || code === 'evaluator_unavailable';
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

/** The submit form's wording for a guardrail or collateral failure, or null for any other error. */
export function mapGuardrailBuildError(err: unknown): MappedBuildError | null {
  const cause = findFailureCause(err);
  if (cause?.code === 'evaluation_failed') return { message: EVALUATION_FAILED_MESSAGE, detail: cause.detail };
  if (cause?.code === 'evaluator_unavailable') return { message: EVALUATOR_UNAVAILABLE_MESSAGE, detail: null };
  const raw = err instanceof Error ? err.message : '';
  if (/\bevaluation_failed\b/.test(raw)) return { message: EVALUATION_FAILED_MESSAGE, detail: null };
  if (/\bevaluator_unavailable\b/.test(raw)) return { message: EVALUATOR_UNAVAILABLE_MESSAGE, detail: null };
  if (/No suitable UTxOs available for collateral|Insufficient collateral available/.test(raw)) {
    return { message: COLLATERAL_SELECTION_MESSAGE, detail: null };
  }
  if (/Collateral return \(\d+ lovelace\) is below minimum UTxO requirement/.test(raw)) {
    return { message: COLLATERAL_TOKENS_MESSAGE, detail: null };
  }
  return null;
}
