// Unit tests for mapGuardrailBuildError and isStalePrevError: the build
// failures a guardrail-checked proposal (treasury withdrawal or parameter
// change) adds, worded for the submit form, and the stale previous action.
import { describe, it, expect } from 'vitest';
import {
  COLLATERAL_SELECTION_MESSAGE,
  COLLATERAL_TOKENS_MESSAGE,
  EVALUATION_FAILED_MESSAGE,
  EVALUATOR_UNAVAILABLE_MESSAGE,
  isStalePrevError,
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
    expect(mapGuardrailBuildError(err, 'TreasuryWithdrawals')).toEqual({ message: EVALUATION_FAILED_MESSAGE, detail: 'Validator returned False' });
  });

  it('words an unreachable evaluator', () => {
    const err = wrapped('Script evaluation failed: evaluator_unavailable', { code: 'evaluator_unavailable', detail: null });
    expect(mapGuardrailBuildError(err, 'TreasuryWithdrawals')).toEqual({ message: EVALUATOR_UNAVAILABLE_MESSAGE, detail: null });
  });

  it('falls back to the message when the cause chain is gone', () => {
    expect(mapGuardrailBuildError(new Error('Script evaluation failed: evaluator_unavailable'), 'TreasuryWithdrawals')).toEqual({
      message: EVALUATOR_UNAVAILABLE_MESSAGE,
      detail: null,
    });
    expect(mapGuardrailBuildError(new Error('Script evaluation failed: evaluation_failed'), 'TreasuryWithdrawals')).toEqual({
      message: EVALUATION_FAILED_MESSAGE,
      detail: null,
    });
  });

  it('words both collateral selection failures the same way', () => {
    for (const raw of [
      'No suitable UTxOs available for collateral. All available UTxOs are either already selected or have reference scripts.',
      'Insufficient collateral available. Need 5000000 lovelace, but only found 3000000 lovelace.',
    ]) {
      expect(mapGuardrailBuildError(new Error(raw), 'TreasuryWithdrawals')).toEqual({ message: COLLATERAL_SELECTION_MESSAGE, detail: null });
    }
  });

  it('words a collateral return below the minimum UTxO as a token problem', () => {
    const raw =
      'Collateral return (1000000 lovelace) is below minimum UTxO requirement (1500000 lovelace). This can happen when collateral inputs have many tokens. Consider selecting UTxOs with pure ADA for collateral, or provide more collateral.';
    expect(mapGuardrailBuildError(new Error(raw), 'TreasuryWithdrawals')).toEqual({ message: COLLATERAL_TOKENS_MESSAGE, detail: null });
  });

  it('leaves every other error, a CIP-30 one included, to the caller', () => {
    expect(mapGuardrailBuildError(new Error('user declined'), 'TreasuryWithdrawals')).toBeNull();
    expect(mapGuardrailBuildError({ code: 2, info: 'user declined' }, 'TreasuryWithdrawals')).toBeNull();
    expect(mapGuardrailBuildError(null, 'TreasuryWithdrawals')).toBeNull();
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

describe('per-type wording', () => {
  it('words the guardrail rejection per type', () => {
    const err = new Error('evaluation_failed', { cause: { code: 'evaluation_failed', detail: 'boom' } });
    expect(mapGuardrailBuildError(err, 'TreasuryWithdrawals')?.message).toBe("The constitution's guardrails script rejected this withdrawal.");
    expect(mapGuardrailBuildError(err, 'ParameterChange')?.message).toBe(
      "The constitution's guardrails script rejected this parameter change.",
    );
  });

  it('words an unsupported parameter change', () => {
    const err = new Error('unsupported_parameter_change', { cause: { code: 'unsupported_parameter_change', detail: null } });
    expect(mapGuardrailBuildError(err, 'ParameterChange')?.message).toBe(
      "DRepTalk only submits changes to k, a0, minPoolCost, rho and tau within the constitution's limits.",
    );
  });

  it('recognizes a stale previous action with and without a hash', () => {
    expect(isStalePrevError('ConwayGovFailure (InvalidPrevGovActionId (ProposalProcedure ...))', null)).toBe(true);
    expect(isStalePrevError(`... ${'ab'.repeat(32)} ...`, 'AB'.repeat(32))).toBe(true);
    expect(isStalePrevError('BadInputsUTxO', null)).toBe(false);
  });

  it("matches Ogmios' wording of a stale previous action", () => {
    // Shortened from the devnet's real submitTransaction rejection.
    const ogmios =
      '{"error":{"code":3159,"message":"The transaction contains invalid or missing reference to previous (ratified) governance proposals. ...","data":{"invalidOrMissingPreviousProposals":[{"type":"protocolParametersUpdate"}]}}}';
    expect(isStalePrevError(ogmios, null)).toBe(true);
  });
});
