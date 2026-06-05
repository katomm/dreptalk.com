// Blake2b-224 (28-byte output) hash helper using blakejs.
import { blake2b } from 'blakejs';

/** Hashes bytes with Blake2b-224 (28-byte output), as used by Cardano key hashing. */
export function blake2b224(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, undefined, 28);
}
