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

// Raw Ed25519 sizes for the Calidus / CC-hot paste login flow: a detached
// signature is exactly 64 bytes (128 hex chars) and a public key exactly 32
// bytes (64 hex chars). These are enforced exactly, not as upper bounds.
export const RAW_SIG_HEX_LEN = 128;
export const RAW_PUBKEY_HEX_LEN = 64;

const HEX_RE = /^[0-9a-fA-F]*$/;

/** True when `s` is an even-length hex string of at most `maxLen` characters. */
export function isHex(s: string, maxLen: number): boolean {
  return s.length <= maxLen && s.length % 2 === 0 && HEX_RE.test(s);
}

/** True when `s` is a hex string of exactly `exactLen` characters. */
export function isHexExact(s: string, exactLen: number): boolean {
  return s.length === exactLen && HEX_RE.test(s);
}

// Post and topic ids are UUIDs (crypto.randomUUID in src/lib/db/forum.ts), so a
// route parameter of any other shape can be refused without touching D1. One
// definition, because every public route carrying such an id gates on it and a
// per-route copy is a rule that has to be found by grep when it changes.
const FORUM_ID_RE = /^[0-9a-f-]{36}$/i;

/** True when `s` has the shape of a forum post or topic id. */
export function isForumId(s: string): boolean {
  return FORUM_ID_RE.test(s);
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

/**
 * Like sanitizeExternalText but for multi-line prose (CIP-108 rationale/abstract):
 * preserves newlines and tabs (so Markdown structure survives), normalizes line
 * endings to \n, collapses 3+ blank lines to one, strips other control chars,
 * trims, and caps length. Still rendered through the hardened markdown sanitizer.
 */
export function sanitizeExternalMultiline(s: string, maxLen: number): string {
  const normalized = s.replace(/\r\n?/g, '\n');
  let out = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0);
    if (code === 10 || code === 9) { out += ch; continue; } // keep newline + tab
    if (code !== undefined && !isControlCode(code)) out += ch;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim().slice(0, maxLen);
}
