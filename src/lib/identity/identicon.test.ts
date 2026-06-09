import { describe, it, expect } from 'vitest';
import { identiconSvg } from './identicon.js';

// 56 hex chars = a 28-byte DRep credential hash (the hex path).
const HEX_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c';
const HEX_B = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

describe('identiconSvg', () => {
  it('returns a deterministic <svg> string for a hex seed', () => {
    const a = identiconSvg(HEX_A);
    expect(a.startsWith('<svg')).toBe(true);
    expect(identiconSvg(HEX_A)).toBe(a);
  });

  it('produces distinct icons for distinct seeds', () => {
    expect(identiconSvg(HEX_A)).not.toBe(identiconSvg(HEX_B));
  });

  it('respects the size option', () => {
    expect(identiconSvg(HEX_A, 40)).toContain('width="40"');
  });
});
