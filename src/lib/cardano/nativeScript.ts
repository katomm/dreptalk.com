// Native (Timelock/multisig) script model plus the two operations the auth flow
// needs: collecting the authorized sig key hashes, and recomputing the ledger
// script hash to bind a Koios-returned script to the credential we queried.
import { blake2b224 } from '../crypto/blake.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';

export type NativeScript =
  | { type: 'sig'; keyHash: string }
  | { type: 'all'; scripts: NativeScript[] }
  | { type: 'any'; scripts: NativeScript[] }
  | { type: 'atLeast'; required: number; scripts: NativeScript[] }
  | { type: 'before'; slot: number }
  | { type: 'after'; slot: number };

const KEYHASH_HEX = /^[0-9a-f]{56}$/;

/**
 * Defensively maps the cardano-cli / Koios native-script JSON into NativeScript.
 * Returns null for any unknown variant (e.g. Plutus) or malformed field, so a
 * non-native or tampered script can never pass as a valid membership source.
 */
export function parseNativeScriptJson(value: unknown): NativeScript | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'sig': {
      const kh = typeof v.keyHash === 'string' ? v.keyHash.toLowerCase() : '';
      return KEYHASH_HEX.test(kh) ? { type: 'sig', keyHash: kh } : null;
    }
    case 'all':
    case 'any': {
      const children = parseChildren(v.scripts);
      return children ? { type: v.type, scripts: children } : null;
    }
    case 'atLeast': {
      const children = parseChildren(v.scripts);
      if (!children || typeof v.required !== 'number' || !Number.isInteger(v.required)) return null;
      return { type: 'atLeast', required: v.required, scripts: children };
    }
    case 'before':
      return typeof v.slot === 'number' ? { type: 'before', slot: v.slot } : null;
    case 'after':
      return typeof v.slot === 'number' ? { type: 'after', slot: v.slot } : null;
    default:
      return null;
  }
}

function parseChildren(scripts: unknown): NativeScript[] | null {
  if (!Array.isArray(scripts)) return null;
  const out: NativeScript[] = [];
  for (const c of scripts) {
    const p = parseNativeScriptJson(c);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** All sig-leaf key hashes (lowercase hex) reachable in the script tree. */
export function collectSigKeyHashes(s: NativeScript, acc: Set<string> = new Set()): Set<string> {
  switch (s.type) {
    case 'sig':
      acc.add(s.keyHash.toLowerCase());
      break;
    case 'all':
    case 'any':
    case 'atLeast':
      for (const c of s.scripts) collectSigKeyHashes(c, acc);
      break;
    case 'before':
    case 'after':
      break;
  }
  return acc;
}

/** Ledger script hash: blake2b-224 of (0x00 native-language tag || CBOR(script)). */
export function nativeScriptHash(s: NativeScript): string {
  const tagged = concat(new Uint8Array([0x00]), encode(s));
  return bytesToHex(blake2b224(tagged));
}

// Conway/Shelley native script CBOR: sig=[0,kh], all=[1,[..]], any=[2,[..]],
// atLeast=[3,n,[..]], invalidBefore(after)=[4,slot], invalidHereafter(before)=[5,slot].
function encode(s: NativeScript): Uint8Array {
  switch (s.type) {
    case 'sig':
      return arr([uint(0), bstr(hexToBytes(s.keyHash))]);
    case 'all':
      return arr([uint(1), arr(s.scripts.map(encode))]);
    case 'any':
      return arr([uint(2), arr(s.scripts.map(encode))]);
    case 'atLeast':
      return arr([uint(3), uint(s.required), arr(s.scripts.map(encode))]);
    case 'after':
      return arr([uint(4), uint(s.slot)]);
    case 'before':
      return arr([uint(5), uint(s.slot)]);
  }
}

// Minimal CBOR encoder limited to the native-script grammar.
function head(major: number, value: number): Uint8Array {
  const m = major << 5;
  if (value < 24) return new Uint8Array([m | value]);
  if (value < 0x100) return new Uint8Array([m | 24, value]);
  if (value < 0x10000) return new Uint8Array([m | 25, value >> 8, value & 0xff]);
  if (value < 0x100000000)
    return new Uint8Array([m | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
  const hi = Math.floor(value / 0x100000000);
  const lo = value % 0x100000000;
  return new Uint8Array([
    m | 27,
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
  ]);
}
function uint(n: number): Uint8Array {
  if (n < 0 || !Number.isInteger(n)) throw new Error('native script: non-negative integer required');
  return head(0, n);
}
function bstr(b: Uint8Array): Uint8Array {
  return concat(head(2, b.length), b);
}
function arr(items: Uint8Array[]): Uint8Array {
  return concat(head(4, items.length), ...items);
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
