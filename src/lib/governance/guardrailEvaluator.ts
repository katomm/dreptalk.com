// The Evaluator the SDK's build() runs a Plutus transaction through, backed
// by POST /api/gov-action/evaluate instead of the provider's own Koios
// /ogmios call. The browser holds no Koios token and the public proxy
// deliberately does not forward /ogmios, so the server route evaluates and
// this adapter only turns its JSON back into the SDK's EvalRedeemer shape.
//
// Evaluator and EvaluationError are not exported from the SDK barrel, and
// EvalRedeemer is not even re-exported from TransactionBuilder, so both come
// from the package's "./*" subpath exports. Effect comes from the barrel's
// own re-export, the app has no direct effect dependency.
import { Effect, Redeemer, Transaction } from '@evolution-sdk/evolution';
import { EvaluationError, type Evaluator } from '@evolution-sdk/evolution/sdk/builders/TransactionBuilder';
import type { EvalRedeemer } from '@evolution-sdk/evolution/sdk/EvalRedeemer';
import type { EvalRedeemerJson, EvaluateResponse, EvaluationFailureCause } from './evaluateContract.js';
import { isRecord } from '../util/isRecord.js';

type RouteOutcome = { ok: true; redeemers: EvalRedeemer[] } | { ok: false; cause: EvaluationFailureCause };

const UNAVAILABLE: RouteOutcome = { ok: false, cause: { code: 'evaluator_unavailable', detail: null } };

const REDEEMER_TAGS: readonly string[] = ['spend', 'mint', 'cert', 'reward', 'vote', 'propose'];
const UINT_STRING_RE = /^\d+$/;

/** One untrusted redeemer entry checked against the shared contract type, or null. */
function readRedeemerJson(item: unknown): EvalRedeemerJson | null {
  if (!isRecord(item) || !isRecord(item.ex_units)) return null;
  const { redeemer_tag: tag, redeemer_index: index } = item;
  const { mem, steps } = item.ex_units;
  if (typeof tag !== 'string' || !REDEEMER_TAGS.includes(tag)) return null;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  if (typeof mem !== 'string' || !UINT_STRING_RE.test(mem) || typeof steps !== 'string' || !UINT_STRING_RE.test(steps)) {
    return null;
  }
  return { redeemer_tag: tag, redeemer_index: index, ex_units: { mem, steps } };
}

/** The unknown answer read as the route's contract type, or null when it is none of its shapes. */
function readEvaluateResponse(body: unknown): EvaluateResponse | null {
  if (!isRecord(body)) return null;
  if (Array.isArray(body.redeemers)) {
    const redeemers: EvalRedeemerJson[] = [];
    for (const item of body.redeemers) {
      const json = readRedeemerJson(item);
      if (!json) return null;
      redeemers.push(json);
    }
    return { redeemers };
  }
  if (body.error === 'evaluation_failed') {
    return { error: 'evaluation_failed', detail: typeof body.detail === 'string' ? body.detail : '' };
  }
  if (body.error === 'evaluator_unavailable') return { error: 'evaluator_unavailable' };
  if (body.error === 'unsupported_parameter_change') return { error: 'unsupported_parameter_change' };
  return null;
}

/**
 * One call to the evaluate route. Never rejects: the answer is read as
 * unknown and checked before any field is touched, the whole call sits in one
 * try, and every failure (network, status, primitive or array JSON, a
 * malformed field, a throwing ExUnits) comes back as the typed unavailable
 * cause. A rejection here would surface through Effect.promise as a defect
 * instead of an EvaluationError, past the wording the island maps. Every
 * answer other than a 200 with redeemers or a 422 evaluation_failed (400,
 * 401, 413, 429, 503) means the evaluator could not be used.
 */
export async function evaluateThroughRoute(txCborHex: string, origin: string, fetchImpl?: typeof fetch): Promise<RouteOutcome> {
  try {
    const res = await (fetchImpl ?? fetch)(`${origin}/api/gov-action/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ txCborHex }),
    });
    let raw: unknown = null;
    try {
      raw = await res.json();
    } catch {
      raw = null;
    }
    const body = readEvaluateResponse(raw);
    if (!body) return UNAVAILABLE;
    if (res.status === 200 && 'redeemers' in body) {
      return {
        ok: true,
        redeemers: body.redeemers.map((r) => ({
          redeemer_tag: r.redeemer_tag as Redeemer.RedeemerTag,
          redeemer_index: r.redeemer_index,
          ex_units: new Redeemer.ExUnits({ mem: BigInt(r.ex_units.mem), steps: BigInt(r.ex_units.steps) }),
        })),
      };
    }
    if (res.status === 422 && 'error' in body && body.error === 'evaluation_failed') {
      return { ok: false, cause: { code: 'evaluation_failed', detail: body.detail } };
    }
    if (res.status === 400 && 'error' in body && body.error === 'unsupported_parameter_change') {
      return { ok: false, cause: { code: 'unsupported_parameter_change', detail: null } };
    }
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * The Evaluator to pass as build({ evaluator }) for a guardrail-checked
 * proposal. The EvaluationError's message is the bare code and its cause the
 * full EvaluationFailureCause: the SDK re-wraps it as the cause of a
 * TransactionBuilderError, where govActionErrors.ts finds it again.
 */
export function makeGuardrailEvaluator(origin: string, fetchImpl?: typeof fetch): Evaluator {
  return {
    evaluate: (tx) =>
      Effect.flatMap(
        Effect.promise(() => evaluateThroughRoute(Transaction.toCBORHex(tx), origin, fetchImpl)),
        (outcome) =>
          outcome.ok
            ? Effect.succeed(outcome.redeemers)
            : Effect.fail(new EvaluationError({ message: outcome.cause.code, cause: outcome.cause })),
      ),
  };
}
