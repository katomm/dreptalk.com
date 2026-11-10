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

// Group ids carried the output index in two bytes, first under the bech32 prefix `group`, then
// under `drep_group`, until the CIP settled on one byte. Shared links, notifications and stored
// action intents still hold those 34 byte forms, so they are read as the same group.
const GROUP_PREFIX = 'drep_group';
const LEGACY_GROUP_PREFIX = 'group';
const TWO_BYTE_ID_LENGTH = 34;
/** The highest output index a group id can carry in its one index byte. */
const MAX_GROUP_INDEX = 255;

function twoByteGroupId(prefix: string, ref: EventRef): string {
  const bytes = new Uint8Array(TWO_BYTE_ID_LENGTH);
  bytes.set(hexToBytes(ref.txHash), 0);
  bytes[32] = ref.index >> 8;
  bytes[33] = ref.index & 0xff;
  return encodeBech32(prefix, bytes);
}

/**
 * Every spelling a stored group id may have: the current 33 byte form first, then the 34 byte
 * `drep_group1` and `group1` forms. Stored strings are matched against all three.
 */
export function groupIdForms(ref: EventRef): [string, string, string] {
  return [groupIdString(ref), twoByteGroupId(GROUP_PREFIX, ref), twoByteGroupId(LEGACY_GROUP_PREFIX, ref)];
}

/**
 * The forms of a stored or user supplied id string, for lookups that bind all three. A string
 * that is no group id stands for itself in every slot.
 */
export function groupIdFormsOf(id: string): [string, string, string] {
  const ref = groupIdParam(id);
  return ref ? groupIdForms(ref) : [id, id, id];
}

/** A stored id string in the current form, the string itself when it is no readable group id. */
export function canonicalGroupId(id: string): string {
  const ref = groupIdParam(id);
  return ref ? groupIdString(ref) : id;
}

/** Identicon seed of a group, its output reference, so the picture never changes with the id form. */
export function groupIdentSeed(ref: EventRef): string {
  return `${ref.txHash}#${ref.index}`;
}

/** Identicon seed of a group id string, the string itself when it is no readable group id. */
export function groupIdentSeedOf(id: string): string {
  const ref = groupIdParam(id);
  return ref ? groupIdentSeed(ref) : id;
}

/**
 * Parses a group id from a URL parameter or a stored string. Lowercases first, accepts the 33 byte
 * `drep_group1` form and both 34 byte forms, returns null on anything invalid and for a 34 byte
 * form whose index does not fit the one index byte.
 */
export function groupIdParam(param: string | undefined): EventRef | null {
  if (!param) return null;
  const s = param.toLowerCase();
  let decoded: { prefix: string; data: Uint8Array };
  try {
    decoded = decodeBech32(s);
  } catch {
    return null;
  }
  const { prefix, data } = decoded;
  if (data.length === TWO_BYTE_ID_LENGTH && (prefix === GROUP_PREFIX || prefix === LEGACY_GROUP_PREFIX)) {
    const index = ((data[32] as number) << 8) | (data[33] as number);
    return index > MAX_GROUP_INDEX ? null : { txHash: bytesToHex(data.subarray(0, 32)), index };
  }
  try {
    return groupIdFromBech32(s);
  } catch {
    return null;
  }
}
