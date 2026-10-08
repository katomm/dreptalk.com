// The JSON contract of POST /api/gov-action/evaluate, shared by the worker
// that answers it and the browser adapter that reads it, plus the mapping
// from Ogmios evaluateTransaction JSON, the same one KoiosEffect.ts does
// inside the SDK. Leaf module without an SDK import: ExUnits travel as
// decimal strings and only become bigints in the browser adapter.

export interface EvalRedeemerJson {
  redeemer_tag: string;
  redeemer_index: number;
  ex_units: { mem: string; steps: string };
}

export type EvaluateResponse =
  | { redeemers: EvalRedeemerJson[] }
  | { error: 'evaluation_failed'; detail: string }
  | { error: 'evaluator_unavailable' }
  | { error: 'unsupported_parameter_change' };

/**
 * What the browser adapter puts into the SDK's EvaluationError as its cause,
 * and what the island's error mapping looks for in the cause chain of a
 * failed build.
 */
export interface EvaluationFailureCause {
  code: 'evaluation_failed' | 'evaluator_unavailable' | 'unsupported_parameter_change';
  detail: string | null;
}

// Ogmios names two purposes differently from the ledger, the SDK maps them
// the same way.
function ledgerTag(purpose: string): string {
  if (purpose === 'publish') return 'cert';
  if (purpose === 'withdraw') return 'reward';
  return purpose;
}

const DETAIL_MAX = 4000;

/**
 * The Ogmios error codes that mean a script ran and failed, the only ones
 * that become evaluation_failed. Source: the Ogmios API specification
 * (docs/static/ogmios.json in CardanoSolutions/ogmios, master, read
 * 2026-10-06): EvaluateTransactionFailure 3010 ScriptExecutionFailure, whose
 * per-validator entries carry 3011 InvalidRedeemerPointers, 3012
 * ValidationFailure and 3013 UnsuitableOutputReference (listed too, in case a
 * relay reports one at the top level). The other evaluation failures, 3000
 * IncompatibleEra, 3001 UnsupportedEra, 3002 OverlappingAdditionalUtxo, 3003
 * NodeTipTooOld and 3004 CannotCreateEvaluationContext, and every JSON-RPC
 * protocol error (-32xxx) say nothing about the guardrail and stay
 * evaluator_unavailable. The SDK maps no codes at all (KoiosEffect.ts wraps
 * any error as a ProviderError). An assumption until the live run and the
 * E2E confirm what Koios relays.
 */
export const OGMIOS_SCRIPT_FAILURE_CODES: readonly number[] = [3010, 3011, 3012, 3013];

/**
 * An Ogmios evaluateTransaction answer as the route's contract: a result
 * array becomes redeemers, a JSON-RPC error with a script failure code
 * becomes evaluation_failed with its message and data as detail. Anything
 * else (another error code, no code, an unknown shape) is null, and the
 * caller answers evaluator_unavailable. Branches on the body, not on the
 * HTTP status: Koios returns a JSON-RPC error with HTTP 400 (seen on preprod
 * 2026-10-06), and nothing promises it never comes with 200.
 */
export function mapOgmiosEvaluation(
  body: unknown,
): { redeemers: EvalRedeemerJson[] } | { error: 'evaluation_failed'; detail: string } | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as { result?: unknown; error?: unknown };
  if (Array.isArray(o.result)) {
    const redeemers: EvalRedeemerJson[] = [];
    for (const item of o.result) {
      const entry = item as {
        validator?: { purpose?: unknown; index?: unknown };
        budget?: { memory?: unknown; cpu?: unknown };
      };
      const purpose = entry?.validator?.purpose;
      const index = entry?.validator?.index;
      const memory = entry?.budget?.memory;
      const cpu = entry?.budget?.cpu;
      if (typeof purpose !== 'string' || typeof index !== 'number' || typeof memory !== 'number' || typeof cpu !== 'number') {
        return null;
      }
      redeemers.push({
        redeemer_tag: ledgerTag(purpose),
        redeemer_index: index,
        ex_units: { mem: String(memory), steps: String(cpu) },
      });
    }
    return { redeemers };
  }
  if (o.error && typeof o.error === 'object') {
    const error = o.error as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof error.code !== 'number' || !OGMIOS_SCRIPT_FAILURE_CODES.includes(error.code)) return null;
    const message = typeof error.message === 'string' ? error.message : 'Script evaluation failed.';
    const data = error.data === undefined ? '' : ` ${JSON.stringify(error.data)}`;
    return { error: 'evaluation_failed', detail: `${message}${data}`.slice(0, DETAIL_MAX) };
  }
  return null;
}
