// URL-safe base64 encoding/decoding without padding.
// Uses btoa/atob which are available in both workerd and modern Node.js.

/** Encodes a Uint8Array as a base64url string (no padding). */
export function toBase64Url(bytes: Uint8Array): string {
  // Convert bytes to a binary string, then base64-encode, then make URL-safe.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decodes a base64url string (with or without padding) to a Uint8Array.
 * The return type is explicitly ArrayBuffer-backed (which it always is at
 * runtime, the array is freshly allocated) so WebCrypto and PushManager
 * BufferSource parameters accept it without a defensive copy at call sites.
 */
export function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  // Convert URL-safe chars back to standard base64, then re-pad.
  const base64 = str
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
