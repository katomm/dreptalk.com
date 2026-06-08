import { describe, it, expect } from 'vitest';
import { isHex, isHexExact, sanitizeExternalText, sanitizeExternalMultiline, RAW_SIG_HEX_LEN, RAW_PUBKEY_HEX_LEN } from './input.js';

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

  it('strips newlines (single-line behavior unchanged)', () => {
    expect(sanitizeExternalText('line1\nline2', 100)).toBe('line1line2');
    expect(sanitizeExternalText('line1\r\nline2', 100)).toBe('line1line2');
    expect(sanitizeExternalText('tab\there', 100)).toBe('tabhere');
  });
});

describe('sanitizeExternalMultiline', () => {
  const NUL = String.fromCharCode(0);
  const DEL = String.fromCharCode(127);
  const NEL = String.fromCharCode(0x85); // a C1 control

  it('preserves newlines and tabs', () => {
    expect(sanitizeExternalMultiline('line1\nline2', 100)).toBe('line1\nline2');
    expect(sanitizeExternalMultiline('col1\tcol2', 100)).toBe('col1\tcol2');
  });

  it('normalizes CRLF and CR to LF', () => {
    expect(sanitizeExternalMultiline('a\r\nb', 100)).toBe('a\nb');
    expect(sanitizeExternalMultiline('a\rb', 100)).toBe('a\nb');
  });

  it('collapses 3 or more consecutive newlines to exactly 2', () => {
    expect(sanitizeExternalMultiline('a\n\n\nb', 100)).toBe('a\n\nb');
    expect(sanitizeExternalMultiline('a\n\n\n\n\nb', 100)).toBe('a\n\nb');
    // Two consecutive newlines are kept as-is (paragraph break)
    expect(sanitizeExternalMultiline('a\n\nb', 100)).toBe('a\n\nb');
  });

  it('strips other control chars (NUL, DEL, C1) but not newline/tab', () => {
    expect(sanitizeExternalMultiline('a' + NUL + 'b', 100)).toBe('ab');
    expect(sanitizeExternalMultiline('a' + DEL + 'b', 100)).toBe('ab');
    expect(sanitizeExternalMultiline('a' + NEL + 'b', 100)).toBe('ab');
    // Newline and tab survive
    expect(sanitizeExternalMultiline('a\nb\tc', 100)).toBe('a\nb\tc');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeExternalMultiline('  hello  ', 100)).toBe('hello');
    expect(sanitizeExternalMultiline('\n\nhello\n\n', 100)).toBe('hello');
  });

  it('caps at maxLen after all transformations', () => {
    expect(sanitizeExternalMultiline('abcdef', 3)).toBe('abc');
  });

  it('keeps normal multibyte text', () => {
    expect(sanitizeExternalMultiline('Café\nrésumé', 100)).toBe('Café\nrésumé');
  });
});
