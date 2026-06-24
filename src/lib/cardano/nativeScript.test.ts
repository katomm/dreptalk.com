import { describe, it, expect } from 'vitest';
import { parseNativeScriptJson, collectSigKeyHashes, nativeScriptHash } from './nativeScript.js';

const KH = 'e4569cc95f7744c6d39dfa15384e5283fa2dbb39b6fea279621f504f';

describe('parseNativeScriptJson', () => {
  it('parses an any([sig]) script', () => {
    const s = parseNativeScriptJson({ type: 'any', scripts: [{ type: 'sig', keyHash: KH }] });
    expect(s).toEqual({ type: 'any', scripts: [{ type: 'sig', keyHash: KH }] });
  });

  it('parses atLeast with nested all/any and timelocks', () => {
    const s = parseNativeScriptJson({
      type: 'atLeast',
      required: 2,
      scripts: [
        { type: 'sig', keyHash: KH },
        { type: 'all', scripts: [{ type: 'sig', keyHash: 'aa'.repeat(28) }, { type: 'after', slot: 10 }] },
      ],
    });
    expect(s?.type).toBe('atLeast');
  });

  it('returns null for a Plutus / unknown script', () => {
    expect(parseNativeScriptJson({ type: 'PlutusV2', cborHex: 'ff' })).toBeNull();
    expect(parseNativeScriptJson(null)).toBeNull();
    expect(parseNativeScriptJson({ type: 'sig', keyHash: 'xyz' })).toBeNull();
  });
});

describe('collectSigKeyHashes', () => {
  it('gathers all sig leaves and ignores timelocks', () => {
    const s = parseNativeScriptJson({
      type: 'all',
      scripts: [
        { type: 'sig', keyHash: KH },
        { type: 'any', scripts: [{ type: 'sig', keyHash: 'bb'.repeat(28) }] },
        { type: 'before', slot: 99 },
      ],
    })!;
    expect(collectSigKeyHashes(s)).toEqual(new Set([KH, 'bb'.repeat(28)]));
  });
});

describe('nativeScriptHash', () => {
  it('recomputes the ledger script hash for a real preprod any([sig]) script', () => {
    const s = parseNativeScriptJson({ type: 'any', scripts: [{ type: 'sig', keyHash: KH }] })!;
    expect(nativeScriptHash(s)).toBe('21dbab8106dcd5e7a7c47c1ee15d747ecd0bc04231cf6955887cadc0');
  });
});
