import { describe, it, expect } from 'vitest';
import { applySecurityHeaders, relaxStyleSrc } from './securityHeaders.js';

describe('applySecurityHeaders', () => {
  it('sets the expected baseline security headers', () => {
    const headers = new Headers();
    applySecurityHeaders(headers);

    expect(headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Permissions-Policy')).toBe('geolocation=(), microphone=(), camera=()');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('does not set a Content-Security-Policy (emitted by Astro security.csp)', () => {
    const headers = new Headers();
    applySecurityHeaders(headers);
    expect(headers.has('Content-Security-Policy')).toBe(false);
  });

  it('replaces a pre-existing weaker value', () => {
    const headers = new Headers({ 'X-Frame-Options': 'SAMEORIGIN' });
    applySecurityHeaders(headers);
    expect(headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('relaxStyleSrc', () => {
  it('replaces a hash-pinned style-src with permissive inline styles', () => {
    const headers = new Headers({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'sha256-abc'; style-src 'self' 'unsafe-inline' 'sha256-xyz'; frame-ancestors 'none'",
    });
    relaxStyleSrc(headers);
    expect(headers.get('Content-Security-Policy')).toBe(
      "default-src 'self'; script-src 'self' 'sha256-abc'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
  });

  it('leaves the strict script-src directive untouched', () => {
    const headers = new Headers({
      'Content-Security-Policy': "script-src 'self' 'sha256-abc'; style-src 'self' 'sha256-xyz'",
    });
    relaxStyleSrc(headers);
    const csp = headers.get('Content-Security-Policy')!;
    expect(csp).toContain("script-src 'self' 'sha256-abc'");
    expect(csp).not.toContain("style-src 'self' 'sha256-xyz'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('appends style-src when the policy has none', () => {
    const headers = new Headers({ 'Content-Security-Policy': "default-src 'self'" });
    relaxStyleSrc(headers);
    expect(headers.get('Content-Security-Policy')).toBe(
      "default-src 'self'; style-src 'self' 'unsafe-inline'",
    );
  });

  it('does nothing when there is no CSP header', () => {
    const headers = new Headers();
    relaxStyleSrc(headers);
    expect(headers.has('Content-Security-Policy')).toBe(false);
  });

  it('is idempotent when the style-src is already relaxed', () => {
    const csp = "script-src 'self' 'sha256-abc'; style-src 'self' 'unsafe-inline'";
    const headers = new Headers({ 'Content-Security-Policy': csp });
    relaxStyleSrc(headers);
    relaxStyleSrc(headers);
    expect(headers.get('Content-Security-Policy')).toBe(csp);
  });
});
