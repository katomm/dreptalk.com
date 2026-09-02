import { describe, expect, it } from 'vitest';
import { internalErrorResponse, isDatabaseUnavailable, serviceUnavailableResponse } from './serviceUnavailable.js';

describe('isDatabaseUnavailable', () => {
  it('matches the real D1 internal-error outage', () => {
    const err = new Error('D1_ERROR: internal error; reference = 42rm5bpt4obqtj0197i09m0t');
    expect(isDatabaseUnavailable(err)).toBe(true);
  });

  it('matches other transient D1 infra faults', () => {
    for (const msg of [
      'Internal error in D1 DB storage caused object to be reset.',
      'Network connection lost.',
      'Cannot resolve D1 DB due to transient issue on remote node.',
      'D1 DB is overloaded. Too many requests queued.',
      'Exceeded maximum DB size.',
    ]) {
      expect(isDatabaseUnavailable(new Error(msg)), msg).toBe(true);
    }
  });

  it('unwraps a nested cause', () => {
    const err = new Error('render failed', { cause: new Error('D1_ERROR: internal error') });
    expect(isDatabaseUnavailable(err)).toBe(true);
  });

  it('does not match deterministic query bugs', () => {
    expect(isDatabaseUnavailable(new Error('D1_ERROR: no such column: foo'))).toBe(false);
    expect(isDatabaseUnavailable(new Error('D1_TYPE_ERROR: type mismatch'))).toBe(false);
  });

  it('is safe on non-errors', () => {
    expect(isDatabaseUnavailable(null)).toBe(false);
    expect(isDatabaseUnavailable(undefined)).toBe(false);
    expect(isDatabaseUnavailable(42)).toBe(false);
    expect(isDatabaseUnavailable('')).toBe(false);
  });
});

describe('serviceUnavailableResponse', () => {
  it('returns a 503 HTML page for normal routes', async () => {
    const res = serviceUnavailableResponse('/');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'");
    const body = await res.text();
    expect(body).toContain('Briefly unavailable');
    expect(body).not.toContain('<script'); // scriptless by design
  });

  it('returns a 503 JSON body for API routes', async () => {
    const res = serviceUnavailableResponse('/api/topics');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ status: 'unavailable' });
  });
});

describe('internalErrorResponse', () => {
  it('returns a 500 HTML page for normal routes, scriptless and uncached', async () => {
    const res = internalErrorResponse('/analytics/');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    // A bug does not fix itself in 30 seconds, so no retry hint.
    expect(res.headers.get('retry-after')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'");
    const body = await res.text();
    expect(body).toContain('Something went wrong');
    expect(body).not.toContain('Briefly unavailable');
    expect(body).not.toContain('<script');
  });

  it('returns a 500 JSON body for API routes', async () => {
    const res = internalErrorResponse('/api/topics');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ status: 'error' });
  });
});
