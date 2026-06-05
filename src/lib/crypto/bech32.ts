// Thin wrappers around the bech32 package for Cardano address encoding/decoding.
// Always uses limit 1023 because Cardano bech32 strings can exceed the default 90-char limit.
import { bech32 } from 'bech32';

const LIMIT = 1023;

/** Encodes raw bytes as a bech32 string with the given prefix. */
export function encodeBech32(prefix: string, data: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(data), LIMIT);
}

/** Decodes a bech32 string and returns its prefix and raw byte payload. */
export function decodeBech32(s: string): { prefix: string; data: Uint8Array } {
  const { prefix, words } = bech32.decode(s, LIMIT);
  return { prefix, data: new Uint8Array(bech32.fromWords(words)) };
}
