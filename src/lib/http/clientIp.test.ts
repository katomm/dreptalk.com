import { describe, it, expect } from 'vitest';
import { clientIpFrom } from './clientIp.js';

describe('clientIpFrom', () => {
  it('prefers cf-connecting-ip', () => {
    const h = new Headers({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' });
    expect(clientIpFrom(h)).toBe('203.0.113.7');
  });

  it('falls back to the first x-forwarded-for hop, trimmed', () => {
    const h = new Headers({ 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1' });
    expect(clientIpFrom(h)).toBe('198.51.100.1');
  });

  it('returns "unknown" when no client IP header is present', () => {
    expect(clientIpFrom(new Headers())).toBe('unknown');
  });
});
