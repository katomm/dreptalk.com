// Workers-runtime tests for POST /api/auth/link-stake -- the endpoint-layer
// gates (auth, writer-only, same-origin). The verification/link logic itself
// is covered by src/lib/auth/linkStake.workers.test.ts; this file only
// exercises what the route wraps around handleLinkStake, the same split as
// link-challenge.workers.test.ts.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { POST } from '../link-stake';
import { issueNonce } from '@/lib/auth/nonce';

const USER_ID = 'user-link-stake-1';

function ctx(user: { id: string; roles: string[] } | null, headers: Record<string, string> = {}) {
  return ctxWithBody(user, { payload: 'x', signatureHex: 'aa', keyHex: 'bb' }, headers);
}

function ctxWithBody(
  user: { id: string; roles: string[] } | null,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const request = new Request('https://dreptalk.com/api/auth/link-stake', {
    method: 'POST',
    headers: { origin: 'https://dreptalk.com', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
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

  // Regression for the units bug caught by the Phase 3 review: the route used
  // to pass `now` in epoch MILLISECONDS into handleLinkStake, which threads it
  // into consumeNonceForDomain/consumeNonce -- both of which compare it
  // against `issuedAt` in unix SECONDS. That mismatch made every nonce look
  // ~1000x too old, so every real link-stake attempt was rejected as expired,
  // no matter how fresh the nonce. This test issues a REAL nonce through the
  // real issueNonce (not a stubbed consumeNonceForDomain), so it fails before
  // the fix and passes after -- proving the unit conversion end-to-end through
  // the actual route.
  it('accepts a freshly issued nonce (units regression: seconds, not ms)', async () => {
    const userId = 'user-link-stake-real-nonce-1';
    const domain = `link_stake:${userId}`;
    const { payload } = await issueNonce(env.DB, { domain });

    const res = await POST(
      ctxWithBody({ id: userId, roles: ['drep'] }, { payload, signatureHex: 'aa', keyHex: 'bb' }),
    );
    const body = (await res.json()) as { ok: boolean; error?: string };

    // Before the fix this was 401 "invalid or expired nonce" -- the nonce
    // check itself failed. After the fix the nonce is accepted and the flow
    // proceeds to signature verification, which then fails on the dummy
    // signature/key -- a different error, proving the nonce check passed.
    expect(body.error).not.toMatch(/nonce/i);
    expect(body.error).toBe('signature verification failed');
    expect(res.status).toBe(401);
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
