// POST /api/groups/profile
// Hosts a group profile document (CIP-100) and returns the content-addressed url and hash the
// client uses as the group's anchor. Signed-in key DReps and group signers only.
import type { APIRoute } from 'astro';
import { currentNetwork, jsonResponse, runtimeEnv } from '@/lib/api/response';
import { GROUP_SIGNER_ROLE } from '@/lib/auth/roles';
import { PROFILE_DOC_MAX_BYTES, PROFILE_DOC_RATE } from '@/lib/groups/constants';
import { drepGroupsAvailable } from '@/lib/groups/gate';
import { buildProfileDoc, putProfileDoc, type GroupProfileInput } from '@/lib/groups/profileDocs';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';
import { checkRate } from '@/lib/rate';

export const prerender = false;

const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;
const MAX_URL = 500;

function validText(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.trim().length >= min && v.length <= max;
}

function validUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_URL) return false;
  const u = URL.parse(v);
  return u !== null && (u.protocol === 'http:' || u.protocol === 'https:');
}

/** The validated profile, or null for anything off. Optional fields may be missing or empty. */
function parseProfile(raw: unknown): GroupProfileInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!validText(r.name, 1, MAX_NAME)) return null;
  const out: GroupProfileInput = { name: r.name.trim() };
  if (r.description !== undefined && r.description !== '') {
    if (!validText(r.description, 0, MAX_DESCRIPTION)) return null;
    out.description = r.description.trim();
  }
  for (const key of ['website', 'image', 'charter'] as const) {
    const v = r[key];
    if (v === undefined || v === '') continue;
    if (!validUrl(v)) return null;
    out[key] = v;
  }
  return out;
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (!drepGroupsAvailable(currentNetwork().network)) return jsonResponse({ error: 'not found' }, 404);
  const user = (locals as App.Locals).user;
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!user.roles.includes('drep') && !user.roles.includes(GROUP_SIGNER_ROLE)) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }
  if (!isSameOriginRequest(request)) return jsonResponse({ error: 'forbidden' }, 403);

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;
  if (!db || !rateLimiter) return jsonResponse({ error: 'service unavailable' }, 503);

  const now = Date.now();
  const [userOk, ipOk] = await Promise.all([
    checkRate(rateLimiter, `group-profile:${user.id}`, { ...PROFILE_DOC_RATE, now }),
    checkRate(rateLimiter, `group-profile-ip:${clientIpFrom(request.headers)}`, { ...PROFILE_DOC_RATE, now }),
  ]);
  if (!userOk || !ipOk) return jsonResponse({ error: 'rate_limited' }, 429);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }
  const profile = parseProfile(raw);
  if (!profile) return jsonResponse({ error: 'invalid profile' }, 400);
  const doc = buildProfileDoc(profile);
  if (new TextEncoder().encode(doc.body).length > PROFILE_DOC_MAX_BYTES) {
    return jsonResponse({ error: 'profile too large' }, 413);
  }
  await putProfileDoc(db, { hash: doc.hash, body: doc.body, createdBy: user.id, now });
  return jsonResponse({ url: `${new URL(request.url).origin}/group-profile/${doc.hash}.json`, hash: doc.hash });
};
