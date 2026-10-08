// Unit tests for the browser Evaluator: the evaluate route's JSON back into
// the SDK's EvalRedeemer shape, and every failure as an EvaluationError whose
// cause the island's error mapping can read.
import { describe, it, expect, vi } from 'vitest';
import { Effect, Either, Transaction } from '@evolution-sdk/evolution';
import { evaluateThroughRoute, makeGuardrailEvaluator } from './guardrailEvaluator.js';
import { buildEvalTxHex } from './__fixtures__/evaluateTx.js';

function answer(status: number, body: unknown) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

const OK = { redeemers: [{ redeemer_tag: 'propose', redeemer_index: 0, ex_units: { mem: '1000', steps: '2000' } }] };
const UNAVAILABLE = { ok: false, cause: { code: 'evaluator_unavailable', detail: null } };

describe('evaluateThroughRoute', () => {
  it('carries unsupported_parameter_change as its own cause', async () => {
    const outcome = await evaluateThroughRoute('aa', 'https://x', answer(400, { error: 'unsupported_parameter_change' }));
    expect(outcome).toEqual({ ok: false, cause: { code: 'unsupported_parameter_change', detail: null } });
  });

  it('posts the hex to the route and returns EvalRedeemers with bigint ExUnits', async () => {
    const fetchImpl = answer(200, OK);
    const outcome = await evaluateThroughRoute('84a0', 'https://preprod.dreptalk.com', fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://preprod.dreptalk.com/api/gov-action/evaluate');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ txCborHex: '84a0' });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.redeemers).toHaveLength(1);
    expect(outcome.redeemers[0].redeemer_tag).toBe('propose');
    expect(outcome.redeemers[0].redeemer_index).toBe(0);
    expect(outcome.redeemers[0].ex_units.mem).toBe(1000n);
    expect(outcome.redeemers[0].ex_units.steps).toBe(2000n);
  });

  it('carries the script error detail of a failed evaluation', async () => {
    const outcome = await evaluateThroughRoute(
      '84a0',
      'https://x',
      answer(422, { error: 'evaluation_failed', detail: 'Validator returned False' }),
    );
    expect(outcome).toEqual({ ok: false, cause: { code: 'evaluation_failed', detail: 'Validator returned False' } });
  });

  it('reports the evaluator as unavailable for a 503, a 429, a network error or a malformed answer', async () => {
    expect(await evaluateThroughRoute('84a0', 'https://x', answer(503, { error: 'evaluator_unavailable' }))).toEqual(UNAVAILABLE);
    expect(await evaluateThroughRoute('84a0', 'https://x', answer(429, { error: 'rate_limited' }))).toEqual(UNAVAILABLE);
    const offline = vi.fn(async () => {
      throw new TypeError('offline');
    });
    expect(await evaluateThroughRoute('84a0', 'https://x', offline)).toEqual(UNAVAILABLE);
  });

  it('answers unavailable, never rejects, for primitive, array or null JSON', async () => {
    for (const raw of ['"unavailable"', '42', 'true', 'null', '[]', '[{"redeemers":[]}]']) {
      for (const status of [200, 422, 503]) {
        await expect(evaluateThroughRoute('84a0', 'https://x', answer(status, raw))).resolves.toEqual(UNAVAILABLE);
      }
    }
  });

  it('answers unavailable for malformed redeemer fields', async () => {
    const good = OK.redeemers[0];
    const bad = [
      { redeemers: 'propose' },
      { redeemers: [null] },
      { redeemers: [{ ...good, redeemer_tag: 'bogus' }] },
      { redeemers: [{ ...good, redeemer_index: '0' }] },
      { redeemers: [{ ...good, redeemer_index: -1 }] },
      { redeemers: [{ ...good, ex_units: null }] },
      { redeemers: [{ ...good, ex_units: { mem: 1000, steps: '2000' } }] },
      { redeemers: [{ ...good, ex_units: { mem: 'x', steps: '1' } }] },
      { redeemers: [{ redeemer_tag: 'propose' }] },
    ];
    for (const body of bad) {
      await expect(evaluateThroughRoute('84a0', 'https://x', answer(200, body))).resolves.toEqual(UNAVAILABLE);
    }
  });
});

describe('makeGuardrailEvaluator', () => {
  const tx = Transaction.fromCBORHex(buildEvalTxHex());

  it('sends the transaction as CBOR hex and succeeds with the redeemers', async () => {
    const fetchImpl = answer(200, OK);
    const evaluator = makeGuardrailEvaluator('https://x', fetchImpl);
    const result = await Effect.runPromise(evaluator.evaluate(tx, undefined, {} as never));
    expect(result.map((r) => r.redeemer_tag)).toEqual(['propose']);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ txCborHex: Transaction.toCBORHex(tx) });
  });

  it('fails with an EvaluationError that carries the code and the detail', async () => {
    const evaluator = makeGuardrailEvaluator('https://x', answer(422, { error: 'evaluation_failed', detail: 'boom' }));
    const result = await Effect.runPromise(Effect.either(evaluator.evaluate(tx, undefined, {} as never)));
    if (!Either.isLeft(result)) throw new Error('expected a failure');
    expect(result.left._tag).toBe('EvaluationError');
    expect(result.left.message).toBe('evaluation_failed');
    expect(result.left.cause).toEqual({ code: 'evaluation_failed', detail: 'boom' });
  });

  it('fails with the typed unavailable EvaluationError, not a defect, for primitive JSON', async () => {
    for (const raw of ['"unavailable"', '42', 'true', 'null', '[]']) {
      const evaluator = makeGuardrailEvaluator('https://x', answer(200, raw));
      const result = await Effect.runPromise(Effect.either(evaluator.evaluate(tx, undefined, {} as never)));
      if (!Either.isLeft(result)) throw new Error('expected a failure');
      expect(result.left.message).toBe('evaluator_unavailable');
      expect(result.left.cause).toEqual({ code: 'evaluator_unavailable', detail: null });
    }
  });
});
