// Pure cookie helper tests. The KV-backed session store is covered in
// session.workers.test.ts.
import { describe, it, expect } from 'vitest';
import { buildSessionCookie, clearSessionCookie, parseSessionToken } from './session.js';

describe('cookie helpers', () => {
  it('buildSessionCookie contains the token and required flags', () => {
    const token = 'myTestToken';
    const cookie = buildSessionCookie(token);
    expect(cookie).toContain(`dreptalk_session=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=2592000');
  });

  it('buildSessionCookie omits Secure when secure:false is passed', () => {
    const token = 'localDevToken';
    const cookie = buildSessionCookie(token, { secure: false });
    expect(cookie).toContain(`dreptalk_session=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('clearSessionCookie has Max-Age=0', () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain('dreptalk_session=');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
  });

  it('parseSessionToken extracts the token from a valid Cookie header', () => {
    const token = 'abc123def456';
    const header = `other_cookie=val; dreptalk_session=${token}; another=x`;
    expect(parseSessionToken(header)).toBe(token);
  });

  it('parseSessionToken returns null when the cookie is absent', () => {
    expect(parseSessionToken('other=val; foo=bar')).toBeNull();
  });

  it('parseSessionToken returns null for null input', () => {
    expect(parseSessionToken(null)).toBeNull();
  });

  it('parseSessionToken returns null for an empty cookie header', () => {
    expect(parseSessionToken('')).toBeNull();
  });
});
