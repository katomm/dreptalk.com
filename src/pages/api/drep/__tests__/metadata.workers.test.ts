/// <reference types="@cloudflare/workers-types" />
// POST /api/drep/metadata against the real RATE_LIMITER binding. The store and
// build logic and the drepId validation are covered against real D1 in
// src/lib/governance/drepMetadataHandler.workers.test.ts. This file covers only
// the gate the route adds: the per IP rate limit, checked before the body.
import { describe, it, expect } from 'vitest';
import { POST } from '../metadata.js';

describe('POST /api/drep/metadata: rate limiting', () => {
  it('returns 429 once an IP exceeds 10 submissions in the window', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const request = new Request('https://dreptalk.com/api/drep/metadata', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.1' },
        body: 'not json',
      });
      const res = await POST({ request, locals: {} as App.Locals } as Parameters<typeof POST>[0]);
      statuses.push(res.status);
      await res.text();
    }
    expect(statuses).toEqual([...Array(10).fill(400), 429]);
  });
});
