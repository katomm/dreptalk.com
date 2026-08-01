// Workers-runtime tests for POST /api/delegation/track -- the endpoint-layer
// gates (auth, same-origin, rate-limit). The tracking logic itself (stake
// wallet required, ensureFollow + fail-soft resolveFollow) is covered by
// src/lib/delegation/track.workers.test.ts with an injected fake Koios
// client, the same split as link-stake.workers.test.ts /
// linkStake.workers.test.ts. This file never exercises the 200 path because
// the route wires up a real Koios client (network call), not an injectable
// one.
import { describe, it, expect } from 'vitest';
import { POST } from '../track';

const USER_ID = 'user-track-gate-1';

function ctx(user: { id: string; roles: string[] } | null, headers: Record<string, string> = {}) {
  const request = new Request('https://dreptalk.com/api/delegation/track', {
    method: 'POST',
    headers: { origin: 'https://dreptalk.com', ...headers },
  });
  const locals = { user } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof POST>[0];
}

describe('POST /api/delegation/track', () => {
  it('returns 401 when no session is present', async () => {
    const res = await POST(ctx(null));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('returns 403 for a cross-origin request even from a signed-in account', async () => {
    const res = await POST(ctx({ id: USER_ID, roles: ['member'] }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
  });

  it('rate-limits repeated calls per account', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await POST(ctx({ id: USER_ID, roles: ['member'] }));
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});
