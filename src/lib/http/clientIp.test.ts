import { describe, it, expect } from 'vitest';
import { clientIpFrom } from './clientIp.js';

describe('clientIpFrom', () => {
  it('uses cf-connecting-ip', () => {
    const h = new Headers({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' });
    expect(clientIpFrom(h)).toBe('203.0.113.7');
  });

  it('ignores a spoofable x-forwarded-for when cf-connecting-ip is absent', () => {
    const h = new Headers({ 'x-forwarded-for': '198.51.100.1' });
    expect(clientIpFrom(h)).toBe('unknown');
  });

  it('returns "unknown" when no cf-connecting-ip header is present', () => {
    expect(clientIpFrom(new Headers())).toBe('unknown');
  });
});
