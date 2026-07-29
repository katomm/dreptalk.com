// Workers-runtime tests for POST /api/auth/link-stake -- the endpoint-layer
// gates (auth, writer-only, same-origin). The verification/link logic itself
// is covered by src/lib/auth/linkStake.workers.test.ts; this file only
// exercises what the route wraps around handleLinkStake, the same split as
// link-challenge.workers.test.ts.
import { describe, it, expect } from 'vitest';
import { POST } from './link-stake';

const USER_ID = 'user-link-stake-1';

function ctx(user: { id: string; roles: string[] } | null, headers: Record<string, string> = {}) {
  const request = new Request('https://dreptalk.com/api/auth/link-stake', {
    method: 'POST',
    headers: { origin: 'https://dreptalk.com', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ payload: 'x', signatureHex: 'aa', keyHex: 'bb' }),
  });
  const locals = { user } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof POST>[0];
}

describe('POST /api/auth/link-stake', () => {
  it('returns 401 when no session is present', async () => {
    const res = await POST(ctx(null));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('returns 403 for a signed-in member (not a writer role)', async () => {
    const res = await POST(ctx({ id: USER_ID, roles: ['member'] }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('forbidden');
  });

  it('returns 403 for a cross-origin request even from a writer', async () => {
    const res = await POST(ctx({ id: USER_ID, roles: ['drep'] }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
  });

  it('rate-limits repeated calls per account', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await POST(ctx({ id: USER_ID, roles: ['drep'] }));
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});
