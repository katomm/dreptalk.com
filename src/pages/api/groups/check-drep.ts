// GET /api/groups/check-drep?id=<drep id>
// Whether a DRep id may be a founder or an admin of a group: a currently registered key DRep, the
// same rule the action route applies when it opens a create or an update. Signed-in key DReps and
// group signers only, so this is no open proxy to Koios.
import type { APIRoute } from 'astro';
import { currentNetwork, jsonResponse, runtimeEnv } from '@/lib/api/response';
import { drepNamesForKeyHashes } from '@/lib/db/drepGroups';
import { koiosFor, sessionOf } from '@/lib/groups/actionServer';
import { ACTION_RATE } from '@/lib/groups/constants';
import { drepGroupsAvailable } from '@/lib/groups/gate';
import { credentialForDrepId, drepIdForCredential } from '@/lib/groups/ids';
import { checkRate } from '@/lib/rate';

export const prerender = false;

const NO_STORE = { 'cache-control': 'no-store' };

export const GET: APIRoute = async ({ url, locals }) => {
  if (!drepGroupsAvailable(currentNetwork().network)) return jsonResponse({ error: 'not found' }, 404, NO_STORE);
  const user = (locals as App.Locals).user;
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401, NO_STORE);
  const session = sessionOf(user);
  if (!session.keyHash && !session.drepId) return jsonResponse({ error: 'forbidden' }, 403, NO_STORE);

  const cred = credentialForDrepId((url.searchParams.get('id') ?? '').trim());
  if (!cred) return jsonResponse({ error: 'invalid DRep id' }, 400, NO_STORE);
  // A script DRep has no key to sign with, Koios is not asked.
  if (cred.kind === 'script') return jsonResponse({ registered: false, script: true, keyHash: null, name: null }, 200, NO_STORE);

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;
  if (!db || !rateLimiter) return jsonResponse({ error: 'service unavailable' }, 503, NO_STORE);
  if (!(await checkRate(rateLimiter, `group-check-drep:${user.id}`, { ...ACTION_RATE, now: Date.now() }))) {
    return jsonResponse({ error: 'rate_limited' }, 429, NO_STORE);
  }

  const keyHash = cred.hash.toLowerCase();
  try {
    const [info, names] = await Promise.all([
      koiosFor(env).drepInfo(drepIdForCredential({ kind: 'key', hash: keyHash })),
      drepNamesForKeyHashes(db, [keyHash]),
    ]);
    const registered = info?.drep_status === 'registered' && !info.has_script;
    return jsonResponse({ registered, script: false, keyHash, name: names.get(keyHash) ?? null }, 200, NO_STORE);
  } catch (err) {
    console.error('[drep-groups] checking a DRep failed', err);
    return jsonResponse({ error: 'service unavailable' }, 503, NO_STORE);
  }
};
