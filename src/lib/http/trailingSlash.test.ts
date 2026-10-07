import { describe, it, expect } from 'vitest';
import { trailingSlashRedirect } from './trailingSlash.js';

function req(path: string, method = 'GET'): Request {
  return new Request(`https://dreptalk.com${path}`, { method });
}

describe('trailingSlashRedirect', () => {
  it('appends the slash to slashless page routes', () => {
    expect(trailingSlashRedirect(req('/dreps/maureen-c55t7'))).toBe('https://dreptalk.com/dreps/maureen-c55t7/');
    expect(trailingSlashRedirect(req('/t/decrease-treasury-tax-b1389ab3'))).toBe(
      'https://dreptalk.com/t/decrease-treasury-tax-b1389ab3/',
    );
    expect(trailingSlashRedirect(req('/help'))).toBe('https://dreptalk.com/help/');
  });

  it('keeps the query string', () => {
    expect(trailingSlashRedirect(req('/t/foo?tab=discussion'))).toBe('https://dreptalk.com/t/foo/?tab=discussion');
  });

  it('redirects HEAD as well as GET', () => {
    expect(trailingSlashRedirect(req('/dreps', 'HEAD'))).toBe('https://dreptalk.com/dreps/');
  });

  it('leaves paths that already end in a slash alone', () => {
    expect(trailingSlashRedirect(req('/'))).toBeNull();
    expect(trailingSlashRedirect(req('/dreps/maureen-c55t7/'))).toBeNull();
  });

  it('never redirects writes', () => {
    expect(trailingSlashRedirect(req('/t/foo', 'POST'))).toBeNull();
  });

  it('leaves API routes alone', () => {
    expect(trailingSlashRedirect(req('/api'))).toBeNull();
    expect(trailingSlashRedirect(req('/api/health'))).toBeNull();
  });

  it('leaves file-like routes alone', () => {
    expect(trailingSlashRedirect(req('/sitemap.xml'))).toBeNull();
    expect(trailingSlashRedirect(req('/og/t/foo.png'))).toBeNull();
    expect(trailingSlashRedirect(req('/cip100/topic/abc.json'))).toBeNull();
    expect(trailingSlashRedirect(req('/vote/record.csv'))).toBeNull();
    expect(trailingSlashRedirect(req('/llms.txt'))).toBeNull();
  });

  it('leaves internal underscore paths alone', () => {
    expect(trailingSlashRedirect(req('/_server-islands/Foo'))).toBeNull();
  });
});
