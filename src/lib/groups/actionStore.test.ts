// The overlap of a new action's inputs with the fee inputs open actions hold, pure.
import { describe, expect, it } from 'vitest';
import { actionHoldingInputs, inputsHeldBy, type OpenInputs } from './actionStore.js';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const open: OpenInputs[] = [
  { id: 'r1', createdBy: 'u1', feeInputs: [{ txHash: A, index: 0 }] },
  { id: 'r2', createdBy: 'u2', feeInputs: [{ txHash: B, index: 1 }] },
  { id: 'r3', createdBy: 'u1', feeInputs: [{ txHash: A, index: 0 }, { txHash: B, index: 2 }] },
];

describe('actionHoldingInputs', () => {
  it('finds the first open action that spends any of the inputs, by hash and index', () => {
    expect(actionHoldingInputs(open, [{ txHash: A.toUpperCase(), index: 0 }])?.id).toBe('r1');
    expect(actionHoldingInputs(open, [{ txHash: B, index: 7 }, { txHash: B, index: 1 }])?.id).toBe('r2');
  });

  it('answers null when no output is shared', () => {
    expect(actionHoldingInputs(open, [{ txHash: A, index: 1 }])).toBeNull();
    expect(actionHoldingInputs([], [{ txHash: A, index: 0 }])).toBeNull();
    expect(actionHoldingInputs(open, [])).toBeNull();
  });
});

describe('inputsHeldBy', () => {
  it('lists the outputs of the user own rows once each', () => {
    expect(inputsHeldBy(open, 'u1')).toEqual([
      { txHash: A, index: 0 },
      { txHash: B, index: 2 },
    ]);
    expect(inputsHeldBy(open, 'u3')).toEqual([]);
  });
});
