/// <reference types="@cloudflare/workers-types" />
// Wiring test for GET /api/gov-action/context. The handler's own cases live in
// actionContextHandler.workers.test.ts, this only proves the exported route
// builds its dependencies and delegates.
import { describe, it, expect } from 'vitest';
import { GET } from '../context.js';

describe('GET /api/gov-action/context', () => {
  it('401s when signed out', async () => {
    const request = new Request('https://dreptalk.com/api/gov-action/context?type=InfoAction', {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const res = await GET({ request, locals: { user: null } as App.Locals } as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });
});
