// Unit tests for loadDrepNativeScript: every failure keeps the exact error
// string and status the POST /api/drep/multisig route has always returned.
import { describe, it, expect, vi } from 'vitest';
import { loadDrepNativeScript } from './drepNativeScript.js';
import { nativeScriptHash, parseNativeScriptJson } from '@/lib/cardano/nativeScript.js';
import { encodeBech32 } from '@/lib/crypto/bech32.js';
import { hexToBytes } from '@/lib/crypto/hex.js';
import { DREP_KEY_HEADER, DREP_SCRIPT_HEADER } from '@/lib/cardano/identity.js';

const VALUE = { type: 'any', scripts: [{ type: 'sig', keyHash: 'a'.repeat(56) }] };
const HASH = nativeScriptHash(parseNativeScriptJson(VALUE)!);

function drepId(header: number, hashHex: string): string {
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(hexToBytes(hashHex), 1);
  return encodeBech32('drep', payload);
}

function koiosReturning(info: { script_hash: string; type: string; value: unknown } | null) {
  return { scriptInfo: vi.fn(async () => info) };
}

describe('loadDrepNativeScript', () => {
  it('rejects a key DRep without calling Koios', async () => {
    const koios = koiosReturning(null);
    const r = await loadDrepNativeScript(koios, drepId(DREP_KEY_HEADER, 'c'.repeat(56)));
    expect(r).toEqual({ ok: false, status: 422, error: 'not a script drep' });
    expect(koios.scriptInfo).not.toHaveBeenCalled();
  });

  it('rejects an unparseable DRep id', async () => {
    const r = await loadDrepNativeScript(koiosReturning(null), 'nonsense');
    expect(r).toEqual({ ok: false, status: 422, error: 'not a script drep' });
  });

  it('reports a missing script', async () => {
    const r = await loadDrepNativeScript(koiosReturning(null), drepId(DREP_SCRIPT_HEADER, HASH));
    expect(r).toEqual({ ok: false, status: 422, error: 'script not found' });
  });

  it('rejects Plutus scripts with the Plutus message', async () => {
    const r = await loadDrepNativeScript(
      koiosReturning({ script_hash: HASH, type: 'plutusV3', value: null }),
      drepId(DREP_SCRIPT_HEADER, HASH),
    );
    expect(r).toEqual({
      ok: false,
      status: 422,
      error: 'Plutus-script DReps cannot vote. Only native-script DReps are supported.',
    });
  });

  it('rejects a timelock value that is not a supported script', async () => {
    const r = await loadDrepNativeScript(
      koiosReturning({ script_hash: HASH, type: 'timelock', value: { type: 'bogus' } }),
      drepId(DREP_SCRIPT_HEADER, HASH),
    );
    expect(r).toEqual({ ok: false, status: 422, error: 'unsupported script' });
  });

  it('rejects a script whose recomputed hash differs from the DRep hash', async () => {
    const other = { type: 'any', scripts: [{ type: 'sig', keyHash: 'f'.repeat(56) }] };
    const r = await loadDrepNativeScript(
      koiosReturning({ script_hash: HASH, type: 'timelock', value: other }),
      drepId(DREP_SCRIPT_HEADER, HASH),
    );
    expect(r).toEqual({ ok: false, status: 422, error: 'script hash mismatch' });
  });

  it('returns the parsed script and the raw value on success', async () => {
    const koios = koiosReturning({ script_hash: HASH, type: 'timelock', value: VALUE });
    const r = await loadDrepNativeScript(koios, drepId(DREP_SCRIPT_HEADER, HASH));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(VALUE);
      expect(r.hashHex).toBe(HASH);
      expect(nativeScriptHash(r.script)).toBe(HASH);
    }
    expect(koios.scriptInfo).toHaveBeenCalledWith(HASH);
  });
});
