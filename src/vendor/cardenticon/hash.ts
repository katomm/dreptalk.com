/**
 * cyrb128, a fast 128-bit (4x32-bit) non-cryptographic string hash.
 *
 * Used as fallback for inputs that are neither Cardano addresses nor hex strings.
 * Produces 16 well-distributed bytes from any string, which is enough for all
 * 7 visual parameters the renderer needs.
 *
 * Based on: https://stackoverflow.com/a/52171480 (public domain)
 */
export function hashString(str: string): Uint8Array {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;

  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }

  // Finalizer: mix bits to reduce correlation between similar inputs
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;

  // Pack 4x 32-bit integers into 16 bytes
  const result = new Uint8Array(16);
  const view = new DataView(result.buffer);
  view.setUint32(0, h1 >>> 0);
  view.setUint32(4, h2 >>> 0);
  view.setUint32(8, h3 >>> 0);
  view.setUint32(12, h4 >>> 0);
  return result;
}

/** Parse a hex string into raw bytes. Each pair of hex chars becomes one byte. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

/** Check if a string is a hex-encoded value (min 14 chars = 7 bytes for the renderer). */
export function isHex(str: string): boolean {
  return str.length >= 14 && HEX_RE.test(str);
}
