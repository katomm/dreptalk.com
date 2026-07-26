import { describe, it, expect } from 'vitest';
import { isSameOriginRequest } from './origin.js';

function req(headers: Record<string, string>): Request {
  return new Request('https://dreptalk.com/api/auth/pair/start', { method: 'POST', headers });
}

describe('isSameOriginRequest', () => {
  it('accepts same-origin and direct navigations', () => {
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'none' }))).toBe(true);
  });

  it('rejects cross-site requests', () => {
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('falls back to Origin when Sec-Fetch-Site is absent', () => {
    expect(isSameOriginRequest(req({ origin: 'https://dreptalk.com' }))).toBe(true);
    expect(isSameOriginRequest(req({ origin: 'https://evil.example' }))).toBe(false);
  });

  it('allows requests with neither header', () => {
    expect(isSameOriginRequest(req({}))).toBe(true);
  });
});
