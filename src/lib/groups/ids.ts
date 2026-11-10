import { type Credential, type EventRef, groupIdFromBech32, groupIdToBech32, type Network } from 'drep-groups';
import type { CardanoNetwork } from '../config/network.js';
import { decodeBech32, encodeBech32 } from '../crypto/bech32.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';
import { DREP_KEY_HEADER, DREP_SCRIPT_HEADER, parseDrepId } from '../cardano/identity.js';

/** The address network the library checks payment addresses against: mainnet, or testnet for preprod. */
export function addressNetwork(network: CardanoNetwork): Network {
  return network === 'mainnet' ? 'mainnet' : 'testnet';
}

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

// Group ids used the bech32 prefix `group` until the CIP renamed it to `drep_group`.
// Shared links, notifications and stored action intents still carry the old form.
const LEGACY_GROUP_PREFIX = 'group';

function legacyGroupId(s: string): EventRef | null {
  try {
    const { prefix, data } = decodeBech32(s);
    if (prefix !== LEGACY_GROUP_PREFIX || data.length !== 34) return null;
    return { txHash: bytesToHex(data.subarray(0, 32)), index: ((data[32] as number) << 8) | (data[33] as number) };
  } catch {
    return null;
  }
}

/** Parses a group id from a URL parameter. Lowercases first, accepts the legacy `group1` form, returns null on anything invalid. */
export function groupIdParam(param: string | undefined): EventRef | null {
  if (!param) return null;
  const s = param.toLowerCase();
  try {
    return groupIdFromBech32(s);
  } catch {
    return legacyGroupId(s);
  }
}
