/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/auth/pair/poll.
// Calls the exported POST handler directly with a synthetic APIContext, the
// same convention as src/pages/api/vote/record.workers.test.ts, so the test
// runs inside the real Workers runtime (D1, KV, the RATE_LIMITER Durable
// Object) without needing an HTTP server or the Astro middleware chain.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createPairing, approvePairing } from '@/lib/auth/pairing';
import { POST } from './poll';

const NOW = 1_700_000_000;
const USER_ID = 'user-pair-poll-1';

// Insert a user row, is_drep flag controllable per test.
async function seedUser(isDrep: 0 | 1) {
  await env.DB.prepare(
    `INSERT INTO users (id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at)
     VALUES (?, ?, 0, 0, 0, 'member', 'active', ?, ?)`,
  )
    .bind(USER_ID, isDrep, NOW, NOW)
    .run();
}

// Builds a synthetic APIContext for POST /api/auth/pair/poll.
// The endpoint is authenticated by the device secret, not by a session, so
// locals.user is always null here.
function ctx(body: { pairingId: string; deviceSecret: string }) {
  const request = new Request('https://dreptalk.com/api/auth/pair/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const locals = { user: null } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof POST>[0];
}

// Creates a pairing and approves it for USER_ID, returning the values the
// device would hold. No `now` override: the route calls pollPairing with the
// real clock, so the pairing must be created against the real clock too, or
// it would already read as expired by the time the route polls it.
async function createApprovedPairing() {
  const p = await createPairing(env.DB, { userAgent: null });
  await approvePairing(env.DB, p.code, USER_ID, ['drep']);
  return p;
}

describe('POST /api/auth/pair/poll', () => {
  it('mints a session cookie for the winning poll and reports the account and its roles', async () => {
    await seedUser(1);
    const p = await createApprovedPairing();

    const res = await POST(ctx({ pairingId: p.pairingId, deviceSecret: p.deviceSecret }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; user: { id: string; roles: string[] } };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('signed-in');
    expect(body.user.id).toBe(USER_ID);
    expect(body.user.roles).toContain('drep');
    expect(res.headers.get('set-cookie')).toContain('dreptalk_session=');
  });

  it('resolves roles at redemption instead of at approval', async () => {
    // Approve while the user still holds is_drep = 1 ...
    await seedUser(1);
    const p = await createApprovedPairing();

    // ... then the role is lost before the device ever redeems the pairing.
    await env.DB.prepare('UPDATE users SET is_drep = 0 WHERE id = ?').bind(USER_ID).run();

    const res = await POST(ctx({ pairingId: p.pairingId, deviceSecret: p.deviceSecret }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { roles: string[] } };
    // A role snapshot taken at approval time would still carry 'drep' here;
    // the session must reflect the CURRENT row, which has lost it.
    expect(body.user.roles).not.toContain('drep');
    expect(body.user.roles).toEqual(['member']);
  });

  it('returns pending before approval and unknown once the pairing has been claimed', async () => {
    await seedUser(0);
    const p = await createPairing(env.DB, { userAgent: null });

    const pending = await POST(ctx({ pairingId: p.pairingId, deviceSecret: p.deviceSecret }));
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as { status: string }).status).toBe('pending');

    await approvePairing(env.DB, p.code, USER_ID, ['drep']);

    const first = await POST(ctx({ pairingId: p.pairingId, deviceSecret: p.deviceSecret }));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe('signed-in');

    // The atomic claim already flipped the record to consumed, so the second
    // poll (whether a retry from the same device or a second window) must not
    // mint a second session.
    const second = await POST(ctx({ pairingId: p.pairingId, deviceSecret: p.deviceSecret }));
    expect(second.status).toBe(404);
    expect(((await second.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('blocks a caller that keeps polling pairings it cannot resolve', async () => {
    const statuses: number[] = [];
    // Each attempt uses a different pairing id, the way an attacker probing the
    // endpoint would: the per-pairing limiter cannot see that pattern, so the
    // per-IP failure limiter has to be the one that stops it.
    for (let i = 0; i < 40; i++) {
      const res = await POST(ctx({ pairingId: `no-such-pairing-${i}`, deviceSecret: 'nope' }));
      statuses.push(res.status);
      if (res.status === 429) {
        expect(((await res.json()) as { error: string }).error).toBe('rate_limited');
        break;
      }
      expect(res.status).toBe(404);
    }
    expect(statuses).toContain(429);
  });

  it('never charges the failure limit to a device polling a valid pairing', async () => {
    await seedUser(0);
    const p = await createPairing(env.DB, { userAgent: null });

    // Comfortably more polls than the failure limit allows. A device waiting out
    // the full pairing TTL polls this often, and must never be locked out for it.
    for (let i = 0; i < 35; i++) {
      const res = await POST(ctx({ pairingId: p.pairingId, deviceSecret: p.deviceSecret }));
      expect(res.status).toBe(200);
    }
  });

  it('writes exactly one device_paired notification for the account', async () => {
    await seedUser(0);
    const p = await createApprovedPairing();

    const res = await POST(ctx({ pairingId: p.pairingId, deviceSecret: p.deviceSecret }));
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ?1 AND type = 'device_paired'",
    )
      .bind(USER_ID)
      .first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it('stamps the device_paired notification in epoch milliseconds', async () => {
    await seedUser(0);
    const p = await createApprovedPairing();

    const before = Date.now();
    const res = await POST(ctx({ pairingId: p.pairingId, deviceSecret: p.deviceSecret }));
    expect(res.status).toBe(200);
    const after = Date.now();

    const row = await env.DB.prepare(
      "SELECT created_at FROM notifications WHERE recipient_id = ?1 AND type = 'device_paired'",
    )
      .bind(USER_ID)
      .first<{ created_at: number }>();

    // Every other writer of notifications.created_at stores milliseconds, and
    // both the inbox ordering and the per-channel delivered_until cursors read
    // it as such. A seconds value (roughly 1.7e9 against a 1.7e12 cursor) would
    // sort below everything and could never exceed a delivery cursor, so the
    // security alert would silently never be delivered. Bounding the value by
    // the wall clock around the request fails immediately if the division back
    // to seconds is ever reintroduced.
    expect(row!.created_at).toBeGreaterThanOrEqual(before);
    expect(row!.created_at).toBeLessThanOrEqual(after);
    // Explicit about the unit as well, so the intent survives a refactor of the
    // bounds above: seconds since the epoch are four orders of magnitude smaller.
    expect(row!.created_at).toBeGreaterThan(1_000_000_000_000);
  });

  it('never writes a notification when the poll does not mint a session', async () => {
    await seedUser(0);
    const p = await createPairing(env.DB, { userAgent: null });

    // Still pending: no session, so no notification either.
    await POST(ctx({ pairingId: p.pairingId, deviceSecret: p.deviceSecret }));

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ?1 AND type = 'device_paired'",
    )
      .bind(USER_ID)
      .first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});
