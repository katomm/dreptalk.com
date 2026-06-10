/**
 * Minimal bech32 decoder for Cardano addresses.
 *
 * Bech32 encodes data as a human-readable prefix (hrp), a separator "1",
 * and a base-32 string using the charset below. The last 6 characters are
 * a checksum (not validated here, we only need the payload bytes).
 *
 * Cardano address structure after decoding:
 * - Byte 0: header (upper nibble = address type, lower nibble = network id)
 * - Bytes 1-28: payment credential (blake2b-224 hash)
 * - Bytes 29-56: stake credential (blake2b-224 hash), only for base addresses
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const CARDANO_PREFIXES = ['addr1', 'addr_test1', 'stake1', 'stake_test1'];

/** Check if a string looks like a Cardano bech32 address. */
export function isCardanoAddress(str: string): boolean {
  const lower = str.toLowerCase();
  return CARDANO_PREFIXES.some((p) => lower.startsWith(p));
}

/** Decode a bech32 string into its raw payload bytes. */
export function decodeBech32(str: string): Uint8Array {
  str = str.toLowerCase();

  // The last "1" separates the human-readable part from the data
  const pos = str.lastIndexOf('1');
  if (pos < 1) throw new Error('Invalid bech32 string');

  const dataStr = str.slice(pos + 1);
  const values: number[] = [];

  for (const ch of dataStr) {
    const idx = CHARSET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid bech32 character: ${ch}`);
    values.push(idx);
  }

  // Strip the 6-character checksum, then convert 5-bit groups to 8-bit bytes
  return convert5to8(values.slice(0, -6));
}

/** Convert an array of 5-bit values to 8-bit bytes (bech32 to raw). */
function convert5to8(data: number[]): Uint8Array {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];

  for (const value of data) {
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      result.push((acc >> bits) & 0xff);
    }
  }

  return new Uint8Array(result);
}
