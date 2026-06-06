// Validation helpers for untrusted input (auth request bodies) and external /
// on-chain data, applied before any decode, crypto, storage, or rendering.
//
// Rationale: the /api/auth/verify endpoint is public and unauthenticated, so it
// must reject abusive or malformed input cheaply, before allocating buffers,
// decoding hex, or doing crypto. On-chain / API-sourced free text (future DRep
// and pool metadata, CIP-20 labels) must be stripped of control characters and
// length-capped before it is stored or escaped into a page.

// Generous upper bounds for the CIP-8 login body. Real values are far smaller
// (a COSE_Key is well under 100 bytes, a login COSE_Sign1 under ~500), so these
// never reject a legitimate request; they only stop oversized payloads from
// reaching the hex decoder and signature verification.
export const MAX_PAYLOAD_LEN = 2048;
export const MAX_KEY_HEX_LEN = 4096;
export const MAX_SIG_HEX_LEN = 16384;

const HEX_RE = /^[0-9a-fA-F]*$/;

/** True when `s` is an even-length hex string of at most `maxLen` characters. */
export function isHex(s: string, maxLen: number): boolean {
  return s.length <= maxLen && s.length % 2 === 0 && HEX_RE.test(s);
}

// A code point is a control character if it is a C0 control (0 to 31), DEL (127),
// or a C1 control (128 to 159). Comparing by code point keeps this source
// ASCII-only and avoids embedding literal control bytes.
function isControlCode(code: number): boolean {
  return code <= 31 || (code >= 127 && code <= 159);
}

/**
 * Normalizes untrusted external free text for safe storage and display:
 * removes control characters, trims surrounding whitespace, and caps the length.
 * The result must still be HTML-escaped at render time (this does not encode).
 */
export function sanitizeExternalText(s: string, maxLen: number): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code !== undefined && !isControlCode(code)) out += ch;
  }
  return out.trim().slice(0, maxLen);
}
