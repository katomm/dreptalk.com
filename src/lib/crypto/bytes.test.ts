import { describe, it, expect } from 'vitest';
import { bytesEqual } from './bytes';

describe('bytesEqual', () => {
  it('returns true for two equal arrays', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('returns false for arrays of different length', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('returns false when one byte differs', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
});
