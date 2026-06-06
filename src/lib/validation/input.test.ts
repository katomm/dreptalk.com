import { describe, it, expect } from 'vitest';
import { isHex, sanitizeExternalText } from './input.js';

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
