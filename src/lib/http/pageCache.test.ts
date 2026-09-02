import { describe, it, expect } from 'vitest';
import { pageCacheKey, isCacheableRequest, isCacheableResponse } from './pageCache.js';

const req = (url: string, init?: RequestInit) => new Request(url, init);
const res = (status: number, headers: Record<string, string>) => new Response('<html></html>', { status, headers });
const PAGE = 'https://dreptalk.com/dreps/';

describe('pageCacheKey', () => {
  it('keys on the URL as a GET, ignoring nothing else', () => {
    const key = pageCacheKey(PAGE);
    expect(key.url).toBe(PAGE);
    expect(key.method).toBe('GET');
  });

  it('carries the deploy version so a new deploy cannot read an older entry', () => {
    const key = pageCacheKey(PAGE, 'deploy-a');
    expect(key.method).toBe('GET');
    expect(new URL(key.url).searchParams.get('__deploy')).toBe('deploy-a');
  });

  it('gives two deploys different keys for the same page', () => {
    expect(pageCacheKey(PAGE, 'deploy-a').url).not.toBe(pageCacheKey(PAGE, 'deploy-b').url);
  });

  it('keeps the page own query parameters alongside the version', () => {
    const key = pageCacheKey(`${PAGE}?page=2`, 'deploy-a');
    const params = new URL(key.url).searchParams;
    expect(params.get('page')).toBe('2');
    expect(params.get('__deploy')).toBe('deploy-a');
  });

  it('falls back to the bare URL when no version is available', () => {
    expect(pageCacheKey(PAGE, undefined).url).toBe(PAGE);
    expect(pageCacheKey(PAGE, '').url).toBe(PAGE);
  });
});

describe('isCacheableRequest', () => {
  it('caches an anonymous GET (no cookie at all)', () => {
    expect(isCacheableRequest(req(PAGE))).toBe(true);
  });

  it('caches a GET whose cookies do not include the session cookie', () => {
    expect(isCacheableRequest(req(PAGE, { headers: { Cookie: 'theme=dark; foo=1' } }))).toBe(true);
  });

  it('bypasses a GET carrying a session cookie', () => {
    expect(isCacheableRequest(req(PAGE, { headers: { Cookie: 'dreptalk_session=abc123' } }))).toBe(false);
  });

  it('bypasses non-GET requests', () => {
    expect(isCacheableRequest(req(PAGE, { method: 'POST' }))).toBe(false);
    expect(isCacheableRequest(req(PAGE, { method: 'HEAD' }))).toBe(false);
  });
});

describe('isCacheableResponse', () => {
  const anon = null;
  const user = { id: 'u1' };

  it('caches an anonymous public HTML 200', () => {
    expect(isCacheableResponse(res(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, s-maxage=30' }), anon)).toBe(true);
    expect(isCacheableResponse(res(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=300, s-maxage=3600' }), anon)).toBe(true);
  });

  it('never caches an authenticated render', () => {
    expect(isCacheableResponse(res(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, s-maxage=30' }), user)).toBe(false);
  });

  it('does not cache no-store or private responses', () => {
    expect(isCacheableResponse(res(200, { 'Content-Type': 'text/html', 'Cache-Control': 'private, no-store' }), anon)).toBe(false);
    expect(isCacheableResponse(res(200, { 'Content-Type': 'text/html', 'Cache-Control': 'private, s-maxage=30' }), anon)).toBe(false);
  });

  it('does not cache without an explicit public directive', () => {
    expect(isCacheableResponse(res(200, { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=60' }), anon)).toBe(false);
    expect(isCacheableResponse(res(200, { 'Content-Type': 'text/html' }), anon)).toBe(false);
  });

  it('does not cache non-200 or non-HTML responses', () => {
    expect(isCacheableResponse(res(404, { 'Content-Type': 'text/html', 'Cache-Control': 'public, s-maxage=30' }), anon)).toBe(false);
    expect(isCacheableResponse(res(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=30' }), anon)).toBe(false);
  });

  it('does not cache a response that sets a cookie', () => {
    expect(isCacheableResponse(res(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, s-maxage=30', 'Set-Cookie': 'x=1' }), anon)).toBe(false);
  });
});
