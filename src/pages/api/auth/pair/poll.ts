// POST /api/auth/pair/poll: the device half of pairing. Authenticated by the
// device secret, not by a session. The single request that claims an approved
// pairing gets a real session cookie.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { pollPairing } from '@/lib/auth/pairing';
import { rolesFromUser } from '@/lib/auth/roles';
import { createSession, buildSessionCookie } from '@/lib/auth/session';
import { getUserById } from '@/lib/db/users';
import { insertNotifications } from '@/lib/db/notifications';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';
import { parseModerators } from '../../../../../config/moderators.js';

export const prerender = false;

// Polling is expected to be chatty, so the limit is generous enough for a full
// TTL of backed-off polls. Requests that fail to resolve a pairing are capped
// much harder, since those are the ones an attacker would generate.
const POLL_RATE_MAX = 400;
const FAIL_RATE_MAX = 30;
const RATE_WINDOW_SEC = 900;

const bodySchema = z.object({
  pairingId: z.string().min(1).max(128),
  deviceSecret: z.string().min(1).max(128),
});

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!isSameOriginRequest(request)) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

    const env = runtimeEnv(locals as App.Locals);
    const db = env.DB as D1Database | undefined;
    const sessionKv = env.SESSIONS as KVNamespace | undefined;
    const rateLimiter = env.RATE_LIMITER;
    if (!db || !sessionKv || !rateLimiter) {
      return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
    }

    let parsed: { pairingId: string; deviceSecret: string };
    try {
      parsed = bodySchema.parse(await request.json());
    } catch {
      return jsonResponse({ ok: false, error: 'invalid request' }, 400);
    }

    const clientIp = clientIpFrom(request.headers);
    const now = Date.now();
    // Keyed on the pairing id so one device's polling cannot exhaust another's
    // allowance, which matters behind carrier-grade NAT where many users share an IP.
    const allowed = await checkRate(rateLimiter, `pairpoll:${parsed.pairingId}`, {
      max: POLL_RATE_MAX,
      windowSec: RATE_WINDOW_SEC,
      now,
    });
    if (!allowed) return jsonResponse({ ok: false, error: 'rate_limited' }, 429);

    const outcome = await pollPairing(db, parsed.pairingId, parsed.deviceSecret);

    if (outcome.status === 'pending') return jsonResponse({ ok: true, status: 'pending' });

    if (outcome.status === 'unknown') {
      // Unresolvable polls are the attacker-shaped traffic, so they are capped per IP.
      await checkRate(rateLimiter, `pairfail:${clientIp}`, {
        max: FAIL_RATE_MAX,
        windowSec: RATE_WINDOW_SEC,
        now,
      });
      return jsonResponse({ ok: false, error: 'unknown' }, 404);
    }

    // Claimed. Resolve the account's CURRENT roles rather than trusting anything
    // recorded at approval time, so a role lost in between is not carried in.
    const user = await getUserById(db, outcome.userId);
    if (!user) return jsonResponse({ ok: false, error: 'unknown' }, 404);

    const moderators = parseModerators(env.MODERATORS as string | undefined);
    const modRole = user.stake_addr ? (moderators.get(user.stake_addr) ?? null) : null;
    const roles = rolesFromUser(user, modRole);

    const secure = new URL(request.url).protocol === 'https:';
    let token: string;
    try {
      token = await createSession(sessionKv, { id: user.id, roles, drepId: user.drep_id });
    } catch {
      // The pairing was already consumed by the atomic claim above and cannot be
      // handed out twice, so the only safe recovery is to start over. Losing a
      // pairing is an annoyance; two live sessions from one approval would be a
      // security defect.
      return jsonResponse({ ok: false, error: 'pairing_failed' }, 500);
    }

    // Security notice, dispatched only now that a device really is signed in. An
    // approval that is never redeemed did not pair anything.
    await insertNotifications(db, [
      {
        recipientId: user.id,
        type: 'device_paired',
        actorId: null,
        topicId: null,
        postId: null,
        createdAt: Math.floor(Date.now() / 1000),
      },
    ]);

    return jsonResponse(
      {
        ok: true,
        status: 'signed-in',
        user: { id: user.id, roles, displayName: user.display_name ?? null },
      },
      200,
      { 'set-cookie': buildSessionCookie(token, { secure }), 'cache-control': 'no-store' },
    );
  } catch {
    // Unexpected error (e.g. a transient D1 failure or Durable Object RPC
    // issue): return a controlled 503 without leaking any internal detail.
    return jsonResponse({ ok: false, error: 'service unavailable' }, 503);
  }
};
