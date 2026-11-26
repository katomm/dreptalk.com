import { describe, expect, it } from 'vitest';
import { resolveCcRouteParam } from './ccRoute.js';

const HEX = 'a'.repeat(28) + 'b'.repeat(28);

describe('resolveCcRouteParam', () => {
  it('accepts lower-case hex as canonical', () => {
    expect(resolveCcRouteParam(HEX)).toEqual({ kind: 'canonical', hex: HEX });
  });
  it('redirects mixed case to the lower-case form', () => {
    expect(resolveCcRouteParam(HEX.toUpperCase())).toEqual({ kind: 'redirect', hex: HEX });
    expect(resolveCcRouteParam('A' + HEX.slice(1))).toEqual({ kind: 'redirect', hex: HEX });
  });
  it('rejects a wrong length', () => {
    expect(resolveCcRouteParam(HEX.slice(1))).toEqual({ kind: 'invalid' });
    expect(resolveCcRouteParam(HEX + 'a')).toEqual({ kind: 'invalid' });
  });
  it('rejects non-hex and bech32 forms', () => {
    expect(resolveCcRouteParam('g' + HEX.slice(1))).toEqual({ kind: 'invalid' });
    expect(resolveCcRouteParam('cc_cold1' + 'q'.repeat(48))).toEqual({ kind: 'invalid' });
    expect(resolveCcRouteParam('')).toEqual({ kind: 'invalid' });
  });
});
