// Tests for base64url encoding/decoding helpers.
import { describe, it, expect } from 'vitest';
import { toBase64Url, fromBase64Url } from './base64url.js';

describe('toBase64Url', () => {
  it('encodes empty bytes to empty string', () => {
    expect(toBase64Url(new Uint8Array(0))).toBe('');
  });

  it('produces no padding characters', () => {
    const result = toBase64Url(new Uint8Array([1, 2, 3]));
    expect(result).not.toContain('=');
  });

  it('produces no + or / characters (URL-safe)', () => {
    // Generate bytes likely to produce + and / in standard base64.
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const result = toBase64Url(bytes);
    expect(result).not.toContain('+');
    expect(result).not.toContain('/');
  });

  it('encodes known bytes to known base64url', () => {
    // [0xfb, 0xff, 0xfe] -> base64 "+//+" -> base64url "-__-"
    expect(toBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
  });
});

describe('fromBase64Url', () => {
  it('decodes empty string to empty bytes', () => {
    expect(fromBase64Url('')).toEqual(new Uint8Array(0));
  });

  it('decodes known base64url to known bytes', () => {
    expect(fromBase64Url('-__-')).toEqual(new Uint8Array([0xfb, 0xff, 0xfe]));
  });

  it('accepts input with padding', () => {
    const withPad = btoa(String.fromCharCode(1, 2, 3)).replace(/\+/g, '-').replace(/\//g, '_');
    const withoutPad = withPad.replace(/=+$/, '');
    expect(fromBase64Url(withPad)).toEqual(fromBase64Url(withoutPad));
  });
});

describe('round-trip', () => {
  it('round-trips arbitrary bytes', () => {
    const original = new Uint8Array(64);
    for (let i = 0; i < 64; i++) original[i] = (i * 37 + 13) % 256;
    expect(fromBase64Url(toBase64Url(original))).toEqual(original);
  });

  it('round-trips 32 random-looking bytes', () => {
    const bytes = new Uint8Array([
      0x1a, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f, 0x70, 0x81,
      0x92, 0xa3, 0xb4, 0xc5, 0xd6, 0xe7, 0xf8, 0x09,
      0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01, 0x02, 0x03,
      0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80,
    ]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });
});
