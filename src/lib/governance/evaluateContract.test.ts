// Unit tests for mapOgmiosEvaluation: Ogmios evaluateTransaction JSON to the
// evaluate route's own contract, the same mapping KoiosEffect.ts does inside
// the SDK.
import { describe, it, expect } from 'vitest';
import { mapOgmiosEvaluation } from './evaluateContract.js';

describe('mapOgmiosEvaluation', () => {
  it('maps a result to redeemers, budgets as decimal strings and Ogmios purposes to ledger tags', () => {
    expect(
      mapOgmiosEvaluation({
        jsonrpc: '2.0',
        method: 'evaluateTransaction',
        result: [
          { validator: { purpose: 'propose', index: 0 }, budget: { memory: 1000, cpu: 2000 } },
          { validator: { purpose: 'publish', index: 1 }, budget: { memory: 1, cpu: 2 } },
          { validator: { purpose: 'withdraw', index: 2 }, budget: { memory: 3, cpu: 4 } },
        ],
        id: null,
      }),
    ).toEqual({
      redeemers: [
        { redeemer_tag: 'propose', redeemer_index: 0, ex_units: { mem: '1000', steps: '2000' } },
        { redeemer_tag: 'cert', redeemer_index: 1, ex_units: { mem: '1', steps: '2' } },
        { redeemer_tag: 'reward', redeemer_index: 2, ex_units: { mem: '3', steps: '4' } },
      ],
    });
  });

  it('maps a JSON-RPC error to evaluation_failed with the message and the data as detail', () => {
    const mapped = mapOgmiosEvaluation({
      jsonrpc: '2.0',
      method: 'evaluateTransaction',
      error: {
        code: 3010,
        message: 'Some scripts of the transactions terminated with error(s).',
        data: [{ validator: { purpose: 'propose', index: 0 }, error: { code: 3012, message: 'Validator returned False' } }],
      },
      id: null,
    });
    expect(mapped).toMatchObject({ error: 'evaluation_failed' });
    if (!mapped || !('error' in mapped)) throw new Error('unreachable');
    expect(mapped.detail).toContain('Some scripts of the transactions terminated with error(s).');
    expect(mapped.detail).toContain('Validator returned False');
  });

  it('maps every script failure code to evaluation_failed', () => {
    for (const code of [3010, 3011, 3012, 3013]) {
      expect(mapOgmiosEvaluation({ error: { code, message: 'script failed', data: [] } })).toMatchObject({
        error: 'evaluation_failed',
      });
    }
  });

  it('leaves evaluation setup failures and protocol errors to evaluator_unavailable', () => {
    for (const code of [3000, 3001, 3002, 3003, 3004, -32600, -32602, -32603]) {
      expect(mapOgmiosEvaluation({ error: { code, message: 'not about the script' } })).toBeNull();
    }
    expect(mapOgmiosEvaluation({ error: { message: 'no code at all' } })).toBeNull();
    expect(mapOgmiosEvaluation({ error: { code: '3010', message: 'code as a string' } })).toBeNull();
  });

  it('caps a huge error detail', () => {
    const mapped = mapOgmiosEvaluation({ error: { code: 3010, message: 'x', data: 'y'.repeat(10_000) } });
    if (!mapped || !('error' in mapped)) throw new Error('unreachable');
    expect(mapped.detail.length).toBeLessThanOrEqual(4000);
  });

  it('returns null for anything else, so the caller answers evaluator_unavailable', () => {
    expect(mapOgmiosEvaluation(null)).toBeNull();
    expect(mapOgmiosEvaluation('<html>')).toBeNull();
    expect(mapOgmiosEvaluation({ jsonrpc: '2.0' })).toBeNull();
    expect(mapOgmiosEvaluation({ error: 'rate limited' })).toBeNull();
    expect(
      mapOgmiosEvaluation({ result: [{ validator: { purpose: 'propose', index: '0' }, budget: { memory: 1, cpu: 2 } }] }),
    ).toBeNull();
  });
});
