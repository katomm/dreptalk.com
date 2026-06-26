import { describe, it, expect } from 'vitest';
import { isNativeScriptSatisfied, satisfactionProgress } from './nativeScript.js';
import type { NativeScript } from './nativeScript.js';

const sig = (k: string): NativeScript => ({ type: 'sig', keyHash: k });

describe('isNativeScriptSatisfied', () => {
  it('any: satisfied by a single matching signer', () => {
    const s: NativeScript = { type: 'any', scripts: [sig('aa'), sig('bb')] };
    expect(isNativeScriptSatisfied(s, new Set(['bb']))).toBe(true);
    expect(isNativeScriptSatisfied(s, new Set(['cc']))).toBe(false);
  });

  it('all: needs every leaf', () => {
    const s: NativeScript = { type: 'all', scripts: [sig('aa'), sig('bb')] };
    expect(isNativeScriptSatisfied(s, new Set(['aa']))).toBe(false);
    expect(isNativeScriptSatisfied(s, new Set(['aa', 'bb']))).toBe(true);
  });

  it('atLeast: needs >= required distinct children', () => {
    const s: NativeScript = { type: 'atLeast', required: 2, scripts: [sig('aa'), sig('bb'), sig('cc')] };
    expect(isNativeScriptSatisfied(s, new Set(['aa']))).toBe(false);
    expect(isNativeScriptSatisfied(s, new Set(['aa', 'cc']))).toBe(true);
  });

  it('timelocks (before/after) do not block satisfaction', () => {
    const s: NativeScript = { type: 'all', scripts: [sig('aa'), { type: 'after', slot: 10 }] };
    expect(isNativeScriptSatisfied(s, new Set(['aa']))).toBe(true);
  });

  it('nested: atLeast of nested any/all', () => {
    const s: NativeScript = {
      type: 'atLeast',
      required: 2,
      scripts: [sig('aa'), { type: 'all', scripts: [sig('bb'), sig('cc')] }, sig('dd')],
    };
    expect(isNativeScriptSatisfied(s, new Set(['aa', 'bb']))).toBe(false); // only 1 child met (aa); all{bb,cc} not met
    expect(isNativeScriptSatisfied(s, new Set(['aa', 'bb', 'cc']))).toBe(true); // aa + all{bb,cc} = 2
  });
});

describe('satisfactionProgress', () => {
  it('flat atLeast reports threshold and counts', () => {
    const s: NativeScript = { type: 'atLeast', required: 2, scripts: [sig('aa'), sig('bb'), sig('cc')] };
    expect(satisfactionProgress(s, new Set(['aa']))).toEqual({ satisfied: false, signedLeaves: 1, totalLeaves: 3, threshold: 2 });
  });

  it('flat any reports threshold 1', () => {
    const s: NativeScript = { type: 'any', scripts: [sig('aa'), sig('bb')] };
    expect(satisfactionProgress(s, new Set()).threshold).toBe(1);
  });

  it('nested reports null threshold but correct satisfied + leaf counts', () => {
    const s: NativeScript = { type: 'all', scripts: [sig('aa'), { type: 'any', scripts: [sig('bb'), sig('cc')] }] };
    expect(satisfactionProgress(s, new Set(['aa', 'bb']))).toEqual({ satisfied: true, signedLeaves: 2, totalLeaves: 3, threshold: null });
  });
});
