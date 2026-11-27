/// <reference types="@cloudflare/workers-types" />
// Wiring test for POST /api/gov-action/evaluate. The handler's own cases live
// in evaluateHandler.workers.test.ts, this only proves the exported route
// delegates.
import { describe, it, expect } from 'vitest';
import { POST } from '../evaluate.js';

describe('POST /api/gov-action/evaluate', () => {
  it('401s when signed out', async () => {
    const request = new Request('https://dreptalk.com/api/gov-action/evaluate', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    });
    const res = await POST({ request, locals: { user: null } as App.Locals } as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
  });
});
