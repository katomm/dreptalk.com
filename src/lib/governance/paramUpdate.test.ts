import { describe, it, expect } from 'vitest';
import { CBOR, NonnegativeInterval, ProtocolParamUpdate, UnitInterval } from '@evolution-sdk/evolution';
import { buildEvalTxHex, paramChangeProposal } from './__fixtures__/evaluateTx.js';
import { buildParamUpdate, paramUpdateKeysInTx, parseParamUpdate } from './paramUpdate.js';

const r = (n: bigint, d: bigint) => ({ n, d });

describe('buildParamUpdate', () => {
  it('sets exactly the picked fields, reduced', () => {
    const update = buildParamUpdate({ k: r(600n, 1n), a0: r(35n, 100n), rho: r(7n, 2000n) });
    expect(update.nOpt).toBe(600n);
    expect(update.poolPledgeInfluence).toEqual(new NonnegativeInterval.NonnegativeInterval({ numerator: 7n, denominator: 20n }));
    expect(update.expansionRate).toEqual(new UnitInterval.UnitInterval({ numerator: 7n, denominator: 2000n }));
    expect(update.minPoolCost).toBeUndefined();
    expect(update.treasuryGrowthRate).toBeUndefined();
    expect(update.maxBlockBodySize).toBeUndefined();
  });
  it('refuses an empty change', () => {
    expect(() => buildParamUpdate({})).toThrow();
  });
});

describe('parseParamUpdate', () => {
  it('round-trips what buildParamUpdate made', () => {
    const values = { k: r(600n, 1n), minPoolCost: r(170_000_001n, 1n), tau: r(1n, 4n) };
    expect(parseParamUpdate(buildParamUpdate(values))).toEqual({ ok: true, values });
  });
  it('refuses any field outside the five', () => {
    const update = new ProtocolParamUpdate.ProtocolParamUpdate({ nOpt: 600n, maxTxSize: 20000n });
    expect(parseParamUpdate(update)).toEqual({ ok: false, reason: 'foreign_key', field: 'maxTxSize' });
  });
  it('refuses a value outside the bounds', () => {
    expect(parseParamUpdate(new ProtocolParamUpdate.ProtocolParamUpdate({ nOpt: 2001n }))).toEqual({
      ok: false,
      reason: 'out_of_range',
      field: 'nOpt',
    });
  });
  it('refuses an update that changes nothing', () => {
    expect(parseParamUpdate(new ProtocolParamUpdate.ProtocolParamUpdate({}))).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('paramUpdateKeysInTx', () => {
  it('reads the update keys from the raw bytes', () => {
    expect(paramUpdateKeysInTx(buildEvalTxHex({ proposals: [paramChangeProposal()] }))).toEqual([[8]]);
  });
  it('sees a key the SDK decoder would drop', () => {
    const update = new Map<CBOR.CBOR, CBOR.CBOR>([
      [8n, 600n],
      [99n, 1n],
    ]);
    const action = [0n, null, update, null];
    const body = new Map<CBOR.CBOR, CBOR.CBOR>([
      [20n, [[1_000_000_000n, new Uint8Array(29), action, ['https://x', new Uint8Array(32)]]]],
    ]);
    expect(paramUpdateKeysInTx(CBOR.toCBORHex([body, new Map(), true, null]))).toEqual([[8, 99]]);
  });
  it('answers null for bytes that are no transaction', () => {
    expect(paramUpdateKeysInTx('ff')).toBeNull();
  });
});
