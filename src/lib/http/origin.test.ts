import { describe, it, expect } from 'vitest';
import { isSameOriginRequest, crossOriginWriteResponse } from './origin.js';

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

describe('crossOriginWriteResponse', () => {
  function writeReq(method: string, headers: Record<string, string>): Request {
    return new Request('https://dreptalk.com/api/topics', { method, headers });
  }

  it('never blocks safe methods, even cross-site', async () => {
    expect(crossOriginWriteResponse(writeReq('GET', { 'sec-fetch-site': 'cross-site' }))).toBeNull();
    expect(crossOriginWriteResponse(writeReq('HEAD', { 'sec-fetch-site': 'cross-site' }))).toBeNull();
  });

  it('passes same-origin writes and non-browser clients through', () => {
    expect(crossOriginWriteResponse(writeReq('POST', { 'sec-fetch-site': 'same-origin' }))).toBeNull();
    // Server-to-server callers (Telegram webhook, curl) send neither header.
    expect(crossOriginWriteResponse(writeReq('POST', {}))).toBeNull();
  });

  it('rejects cross-site and same-site sibling writes with a 403', async () => {
    const cases: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      // A compromised sibling origin (same registrable site) still gets cookies
      // under SameSite=Lax, so same-site must be rejected too.
      { 'sec-fetch-site': 'same-site' },
      { origin: 'https://preprod.dreptalk.com' },
    ];
    for (const headers of cases) {
      const res = crossOriginWriteResponse(writeReq('POST', headers));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
      expect(((await res!.json()) as { error: string }).error).toContain('cross-origin');
    }
  });

  it('covers every unsafe method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(crossOriginWriteResponse(writeReq(method, { 'sec-fetch-site': 'cross-site' }))).not.toBeNull();
    }
  });
});
