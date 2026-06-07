import { describe, it, expect } from 'vitest';
import { isHex, isHexExact, sanitizeExternalText, RAW_SIG_HEX_LEN, RAW_PUBKEY_HEX_LEN } from './input.js';

describe('isHex', () => {
  it('accepts even-length hex within the limit', () => {
    expect(isHex('00ff', 10)).toBe(true);
    expect(isHex('DEADBEEF', 10)).toBe(true);
    expect(isHex('', 10)).toBe(true);
  });

  it('rejects odd-length hex', () => {
    expect(isHex('abc', 10)).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isHex('zz', 10)).toBe(false);
    expect(isHex('00ff00ff', 10)).toBe(true);
    expect(isHex('00 ff', 10)).toBe(false);
  });

  it('rejects strings longer than maxLen', () => {
    expect(isHex('0'.repeat(12), 10)).toBe(false);
    expect(isHex('0'.repeat(10), 10)).toBe(true);
  });
});

describe('isHexExact', () => {
  it('accepts hex of exactly the required length', () => {
    expect(isHexExact('00ff', 4)).toBe(true);
    expect(isHexExact('0'.repeat(RAW_PUBKEY_HEX_LEN), RAW_PUBKEY_HEX_LEN)).toBe(true);
    expect(isHexExact('a'.repeat(RAW_SIG_HEX_LEN), RAW_SIG_HEX_LEN)).toBe(true);
  });

  it('rejects hex that is too short or too long', () => {
    expect(isHexExact('00', 4)).toBe(false);
    expect(isHexExact('00ff00', 4)).toBe(false);
  });

  it('rejects non-hex characters even at the right length', () => {
    expect(isHexExact('zzzz', 4)).toBe(false);
    expect(isHexExact('00 f', 4)).toBe(false);
  });

  it('uses 128 hex chars for a raw Ed25519 signature and 64 for a pubkey', () => {
    expect(RAW_SIG_HEX_LEN).toBe(128);
    expect(RAW_PUBKEY_HEX_LEN).toBe(64);
  });
});

describe('sanitizeExternalText', () => {
  const NUL = String.fromCharCode(0);
  const ESC = String.fromCharCode(27);
  const DEL = String.fromCharCode(127);
  const NEL = String.fromCharCode(0x85); // a C1 control

  it('strips C0, DEL, and C1 control characters', () => {
    expect(sanitizeExternalText('a' + NUL + 'b' + ESC + 'c' + DEL + 'd' + NEL + 'e', 100)).toBe('abcde');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeExternalText('  hello  ', 100)).toBe('hello');
  });

  it('caps the length', () => {
    expect(sanitizeExternalText('abcdef', 3)).toBe('abc');
  });

  it('keeps normal multibyte text', () => {
    expect(sanitizeExternalText('Café résumé', 100)).toBe('Café résumé');
  });
});
