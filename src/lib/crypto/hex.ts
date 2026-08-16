// Hex encoding and decoding utilities.

/** Regex source for a 32-byte hash as 64 lowercase hex chars, for composing path patterns. */
export const HEX_64_SOURCE = '[0-9a-f]{64}';

/** A 32-byte hash as 64 lowercase hex chars (sha256, blake2b-256). */
export const HEX_HASH_256_RE = new RegExp(`^${HEX_64_SOURCE}$`);

/** Converts a hex string (upper or lowercase) to a Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0);
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length');
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Converts a Uint8Array to a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
