// Blake2b hash helpers using blakejs.
import { blake2b } from 'blakejs';

/** Hashes bytes with Blake2b-224 (28-byte output), as used by Cardano key hashing. */
export function blake2b224(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, undefined, 28);
}

/** Hashes bytes with Blake2b-256 (32-byte output). */
export function blake2b256(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, undefined, 32);
}
