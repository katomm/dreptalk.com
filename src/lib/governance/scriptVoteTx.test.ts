// Deterministic unit test for the native-script to SDK conversion. The full vote
// build needs chain UTxOs and a live wallet, so only the pure conversion is unit
// tested here: a native script converts to an SDK NativeScript whose ledger hash
// ScriptHash.fromScript can compute (a 56-hex, 28-byte script hash).
import { describe, it, expect } from 'vitest';
import { ScriptHash } from '@evolution-sdk/evolution';
import { nativeScriptToSdk } from './scriptVoteTx.js';
import { bytesToHex } from '../crypto/hex.js';
import { nativeScriptHash, type NativeScript } from '../cardano/nativeScript.js';

describe('nativeScriptToSdk', () => {
  it('an any-of-one sig converts to a NativeScript whose ScriptHash is 56 hex', () => {
    const sdk = nativeScriptToSdk({ type: 'any', scripts: [{ type: 'sig', keyHash: 'cc'.repeat(28) }] });
    const hash = bytesToHex(ScriptHash.toBytes(ScriptHash.fromScript(sdk)));
    expect(hash).toMatch(/^[0-9a-f]{56}$/);
  });

  it('the SDK script hash matches our independent native-script hash (any-of-one)', () => {
    const script: NativeScript = { type: 'any', scripts: [{ type: 'sig', keyHash: 'cc'.repeat(28) }] };
    const sdk = nativeScriptToSdk(script);
    const sdkHash = bytesToHex(ScriptHash.toBytes(ScriptHash.fromScript(sdk)));
    expect(sdkHash).toBe(nativeScriptHash(script));
  });

  it('a nested all/atLeast tree with a timelock converts and hashes', () => {
    const sdk = nativeScriptToSdk({
      type: 'all',
      scripts: [
        { type: 'atLeast', required: 2, scripts: [
          { type: 'sig', keyHash: 'aa'.repeat(28) },
          { type: 'sig', keyHash: 'bb'.repeat(28) },
          { type: 'sig', keyHash: 'cc'.repeat(28) },
        ] },
        { type: 'before', slot: 1000 },
        { type: 'after', slot: 10 },
      ],
    });
    const hash = bytesToHex(ScriptHash.toBytes(ScriptHash.fromScript(sdk)));
    expect(hash).toMatch(/^[0-9a-f]{56}$/);
  });
});
