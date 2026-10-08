// GET /api/gov-action/pool-economics
// Pool distribution of the current epoch for the parameter change impact
// panels. All logic lives in handlePoolEconomics.
import type { APIRoute } from 'astro';
import { runtimeEnv, currentNetwork } from '@/lib/api/response';
import { createKoiosClient } from '@/lib/koios/client';
import { handlePoolEconomics } from '@/lib/governance/poolEconomicsHandler';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const net = currentNetwork();
  const env = runtimeEnv(locals);
  const koiosToken = (env.KOIOS_API_KEY as string | undefined) || undefined;
  const koios = createKoiosClient({ baseUrl: net.koiosBaseUrl, token: koiosToken });
  return handlePoolEconomics({ request, locals }, { koios, network: net, env });
};
