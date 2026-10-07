// Loads and validates the native (timelock) script behind a script-credential
// DRep id. Shared by POST /api/drep/multisig (which also binds the tx to it)
// and GET /api/drep/multisig/script (which hands the script to the vote panel,
// because the public Koios proxy does not forward script_info).
import { parseDrepId } from '@/lib/cardano/identity';
import { parseNativeScriptJson, nativeScriptHash, type NativeScript } from '@/lib/cardano/nativeScript';
import type { createKoiosClient } from '@/lib/koios/client';

type KoiosClient = ReturnType<typeof createKoiosClient>;

export type DrepNativeScriptResult =
  | { ok: true; script: NativeScript; value: unknown; hashHex: string }
  | { ok: false; status: 422; error: string };

export async function loadDrepNativeScript(
  koios: Pick<KoiosClient, 'scriptInfo'>,
  drepId: string,
): Promise<DrepNativeScriptResult> {
  const parsedDrep = parseDrepId(drepId);
  if (parsedDrep?.kind !== 'script') {
    return { ok: false, status: 422, error: 'not a script drep' };
  }

  const info = await koios.scriptInfo(parsedDrep.hashHex);
  if (!info) return { ok: false, status: 422, error: 'script not found' };
  if (info.type !== 'timelock') {
    return {
      ok: false,
      status: 422,
      error: 'Plutus-script DReps cannot vote. Only native-script DReps are supported.',
    };
  }

  const script = parseNativeScriptJson(info.value);
  if (!script) return { ok: false, status: 422, error: 'unsupported script' };
  // Recompute the hash so a wrong or tampered Koios answer is rejected.
  if (nativeScriptHash(script) !== parsedDrep.hashHex) {
    return { ok: false, status: 422, error: 'script hash mismatch' };
  }
  return { ok: true, script, value: info.value, hashHex: parsedDrep.hashHex };
}
