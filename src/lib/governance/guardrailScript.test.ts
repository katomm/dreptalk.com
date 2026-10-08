// Asserts the shipped guardrails script and its hash belong together, so the
// stored byte form and the hash cannot drift apart, and pins the decision the
// form and the submit path take on a guardrail state.
import { describe, it, expect } from 'vitest';
import { ScriptHash } from '@evolution-sdk/evolution';
import {
  GUARDRAIL_CHANGED_MESSAGE,
  GUARDRAIL_SCRIPT_CBOR_HEX,
  GUARDRAIL_SCRIPT_HASH_HEX,
  GUARDRAIL_UNKNOWN_MESSAGE,
  guardrailDecision,
  sameGuardrail,
} from './guardrailScript.js';
import { guardrailPlutusScript } from './guardrailPlutusScript.js';

describe('the guardrails script constant', () => {
  it('hashes to the constant hash in exactly the stored byte form', () => {
    expect(ScriptHash.toHex(ScriptHash.fromScript(guardrailPlutusScript()))).toBe(GUARDRAIL_SCRIPT_HASH_HEX);
  });

  it('is the 2,132-byte form Koios returns, lowercase hex, header kept', () => {
    expect(GUARDRAIL_SCRIPT_CBOR_HEX).toMatch(/^[0-9a-f]+$/);
    expect(GUARDRAIL_SCRIPT_CBOR_HEX.length).toBe(4264);
    expect(GUARDRAIL_SCRIPT_CBOR_HEX.startsWith('590851')).toBe(true);
  });

  it('is the hash the constitution names on preview, preprod and mainnet', () => {
    expect(GUARDRAIL_SCRIPT_HASH_HEX).toBe('fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64');
  });
});

describe('guardrailDecision', () => {
  it('accepts the shipped script, whatever the case of the reported hash', () => {
    expect(guardrailDecision({ state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX.toUpperCase() })).toEqual({
      ok: true,
      guardrail: { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX },
    });
  });

  it('accepts a proven absence', () => {
    expect(guardrailDecision({ state: 'absent' })).toEqual({ ok: true, guardrail: { state: 'absent' } });
  });

  it('blocks a script it does not ship', () => {
    expect(guardrailDecision({ state: 'known', scriptHash: 'ab'.repeat(28) })).toEqual({
      ok: false,
      message: GUARDRAIL_CHANGED_MESSAGE,
    });
  });

  it('blocks when there is no guardrail state at all', () => {
    expect(guardrailDecision(undefined)).toEqual({ ok: false, message: GUARDRAIL_UNKNOWN_MESSAGE });
    expect(guardrailDecision(null)).toEqual({ ok: false, message: GUARDRAIL_UNKNOWN_MESSAGE });
  });

  it('uses the spec sentences', () => {
    expect(GUARDRAIL_CHANGED_MESSAGE).toBe(
      "The constitution's guardrails script changed. DRepTalk cannot submit treasury withdrawals or parameter changes until it knows the new script.",
    );
    expect(GUARDRAIL_UNKNOWN_MESSAGE).toBe(
      'The guardrails script could not be checked. Nothing was published or signed. Try again later.',
    );
  });
});

describe('sameGuardrail', () => {
  const KNOWN = { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX } as const;
  it('compares state and normalized hash', () => {
    expect(sameGuardrail(KNOWN, { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX.toUpperCase() })).toBe(true);
    expect(sameGuardrail({ state: 'absent' }, { state: 'absent' })).toBe(true);
    expect(sameGuardrail(KNOWN, { state: 'absent' })).toBe(false);
    expect(sameGuardrail({ state: 'absent' }, KNOWN)).toBe(false);
    expect(sameGuardrail(KNOWN, undefined)).toBe(false);
  });
});
