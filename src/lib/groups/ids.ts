import { type Credential, type EventRef, groupIdFromBech32, groupIdToBech32 } from 'drep-groups';
import { encodeBech32 } from '../crypto/bech32.js';
import { hexToBytes } from '../crypto/hex.js';
import { DREP_KEY_HEADER, DREP_SCRIPT_HEADER, parseDrepId } from '../cardano/identity.js';

/** CIP-129 drep1... id of a key or script credential. */
export function drepIdForCredential(c: Credential): string {
  const hash = hexToBytes(c.hash);
  const payload = new Uint8Array(1 + hash.length);
  payload[0] = c.kind === 'key' ? DREP_KEY_HEADER : DREP_SCRIPT_HEADER;
  payload.set(hash, 1);
  return encodeBech32('drep', payload);
}

/** Credential behind a DRep id, null when the id is not a DRep credential. */
export function credentialForDrepId(drepId: string): Credential | null {
  const parsed = parseDrepId(drepId);
  return parsed ? { kind: parsed.kind, hash: parsed.hashHex } : null;
}

export function groupIdString(ref: EventRef): string {
  return groupIdToBech32(ref);
}

/** Parses a group id from a URL parameter. Lowercases first, returns null on anything invalid. */
export function groupIdParam(param: string | undefined): EventRef | null {
  if (!param) return null;
  try {
    return groupIdFromBech32(param.toLowerCase());
  } catch {
    return null;
  }
}
