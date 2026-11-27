/// <reference types="@cloudflare/workers-types" />
// Wiring test for GET /api/gov-action/status. The handler's own cases live in
// actionStatusHandler.workers.test.ts, this only proves the exported route
// delegates.
import { describe, it, expect } from 'vitest';
import { GET } from '../status.js';

describe('GET /api/gov-action/status', () => {
  it('401s when signed out', async () => {
    const request = new Request(`https://dreptalk.com/api/gov-action/status?id=${encodeURIComponent(`${'a'.repeat(64)}#0`)}`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const res = await GET({ request, locals: { user: null } as App.Locals } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });
});
