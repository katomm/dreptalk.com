// Unit tests for mapGuardrailBuildError: the build failures a treasury
// withdrawal adds, worded for the submit form.
import { describe, it, expect } from 'vitest';
import {
  COLLATERAL_SELECTION_MESSAGE,
  COLLATERAL_TOKENS_MESSAGE,
  EVALUATION_FAILED_MESSAGE,
  EVALUATOR_UNAVAILABLE_MESSAGE,
  mapGuardrailBuildError,
} from './govActionErrors.js';

// The chain build() rejects with (sdk/builders/phases/Evaluation.ts): a
// TransactionBuilderError whose cause is the SDK's re-wrapped EvaluationError,
// whose cause is the adapter's own cause.
function wrapped(message: string, cause: unknown): Error {
  const inner = Object.assign(new Error('Script evaluation failed'), { cause });
  return Object.assign(new Error(message), { cause: inner });
}

describe('mapGuardrailBuildError', () => {
  it('words a guardrail rejection and keeps the script error as detail', () => {
    const err = wrapped('Script evaluation failed: evaluation_failed', {
      code: 'evaluation_failed',
      detail: 'Validator returned False',
    });
    expect(mapGuardrailBuildError(err)).toEqual({ message: EVALUATION_FAILED_MESSAGE, detail: 'Validator returned False' });
  });

  it('words an unreachable evaluator', () => {
    const err = wrapped('Script evaluation failed: evaluator_unavailable', { code: 'evaluator_unavailable', detail: null });
    expect(mapGuardrailBuildError(err)).toEqual({ message: EVALUATOR_UNAVAILABLE_MESSAGE, detail: null });
  });

  it('falls back to the message when the cause chain is gone', () => {
    expect(mapGuardrailBuildError(new Error('Script evaluation failed: evaluator_unavailable'))).toEqual({
      message: EVALUATOR_UNAVAILABLE_MESSAGE,
      detail: null,
    });
    expect(mapGuardrailBuildError(new Error('Script evaluation failed: evaluation_failed'))).toEqual({
      message: EVALUATION_FAILED_MESSAGE,
      detail: null,
    });
  });

  it('words both collateral selection failures the same way', () => {
    for (const raw of [
      'No suitable UTxOs available for collateral. All available UTxOs are either already selected or have reference scripts.',
      'Insufficient collateral available. Need 5000000 lovelace, but only found 3000000 lovelace.',
    ]) {
      expect(mapGuardrailBuildError(new Error(raw))).toEqual({ message: COLLATERAL_SELECTION_MESSAGE, detail: null });
    }
  });

  it('words a collateral return below the minimum UTxO as a token problem', () => {
    const raw =
      'Collateral return (1000000 lovelace) is below minimum UTxO requirement (1500000 lovelace). This can happen when collateral inputs have many tokens. Consider selecting UTxOs with pure ADA for collateral, or provide more collateral.';
    expect(mapGuardrailBuildError(new Error(raw))).toEqual({ message: COLLATERAL_TOKENS_MESSAGE, detail: null });
  });

  it('leaves every other error, a CIP-30 one included, to the caller', () => {
    expect(mapGuardrailBuildError(new Error('user declined'))).toBeNull();
    expect(mapGuardrailBuildError({ code: 2, info: 'user declined' })).toBeNull();
    expect(mapGuardrailBuildError(null)).toBeNull();
  });

  it('uses the spec sentences', () => {
    expect(COLLATERAL_SELECTION_MESSAGE).toBe(
      'Your wallet needs about 5 ada in plain-ada UTxOs that can serve as collateral.',
    );
    expect(COLLATERAL_TOKENS_MESSAGE).toBe(
      "Your wallet's UTxOs carry too many tokens to serve as collateral. Send about 5 ada to it as a separate payment and try again.",
    );
    expect(EVALUATION_FAILED_MESSAGE).toBe("The constitution's guardrails script rejected this withdrawal.");
    expect(EVALUATOR_UNAVAILABLE_MESSAGE).toBe('Could not reach the script evaluator. No transaction was signed.');
  });
});
