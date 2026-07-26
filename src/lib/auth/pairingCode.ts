// Human transferable pairing codes for device pairing. Pure: no bindings and no
// DOM, so it unit-tests in the node project.

// The alphabet excludes every common confusable (0, O, 1, I, L) so a code read
// off a phone screen cannot be typed as a different character. Because the
// alphabet is unambiguous, normalization performs no character remapping.
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PAIRING_CODE_LENGTH = 8;

// 31^8 is about 39.6 bits, quoted after normalization. Rejection sampling keeps
// the modulo unbiased: 31 * 8 = 248, so bytes at 248 and above are discarded
// rather than folded onto the first eight characters.
const REJECT_AT = 248;

/** Generates a canonical (unformatted, upper-case) pairing code. */
export function generatePairingCode(): string {
  const out: string[] = [];
  const buf = new Uint8Array(PAIRING_CODE_LENGTH);
  while (out.length < PAIRING_CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= REJECT_AT) continue;
      out.push(PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]);
      if (out.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return out.join('');
}

/** Splits a canonical code into two groups of four for display. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Canonicalizes user input: upper-cases, strips spaces and hyphens. Returns null
 * when the result is not a valid code.
 *
 * Deliberately performs no ambiguous-character remapping. The alphabet contains
 * no confusables, so there is nothing to map, and any such mapping would collapse
 * distinct inputs onto one canonical code and reduce effective entropy.
 */
export function normalizePairingCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[\s-]/g, '');
  if (stripped.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of stripped) {
    if (!PAIRING_CODE_ALPHABET.includes(ch)) return null;
  }
  return stripped;
}
