// GET /api/drep/multisig/script
// Returns the native-script JSON behind the session user's script DRep, for the
// multisig vote panel. The public Koios proxy does not forward script_info, so
// the browser cannot load the script itself. The DRep id comes from the session
// user record, never from the client.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { getUserById } from '@/lib/db/users';
import { createKoiosClient } from '@/lib/koios/client';
import { resolveNetwork } from '@/lib/config/network';
import { loadDrepNativeScript } from '@/lib/governance/drepNativeScript';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as App.Locals).user;
  if (!user?.roles.includes('drep')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'service unavailable' }, 503);

  const dbUser = await getUserById(db, user.id);
  const drepId = dbUser?.drep_id ?? null;
  if (!drepId) return jsonResponse({ error: 'not a member' }, 403);

  const networkEnv = (env.CARDANO_NETWORK as string | undefined) ?? null;
  const { koiosBaseUrl } = resolveNetwork(networkEnv);
  const koiosToken = (env.KOIOS_API_KEY as string | undefined) || undefined;
  const koios = createKoiosClient({ baseUrl: koiosBaseUrl, token: koiosToken });

  const loaded = await loadDrepNativeScript(koios, drepId);
  if (!loaded.ok) return jsonResponse({ error: loaded.error }, loaded.status);

  return jsonResponse({ value: loaded.value }, 200, { 'cache-control': 'no-store' });
};
