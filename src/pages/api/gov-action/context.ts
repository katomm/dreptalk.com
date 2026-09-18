// GET /api/gov-action/context
// Live ledger context (purpose-chain root/open rows, protocol version,
// committee, constitution script hash) for the /ga/new type selector.
// All logic lives in handleActionContext; this route only wires up the real
// Koios client from the runtime env and delegates.
import type { APIRoute } from 'astro';
import { runtimeEnv, currentNetwork } from '@/lib/api/response';
import { createKoiosClient } from '@/lib/koios/client';
import { handleActionContext } from '@/lib/governance/actionContextHandler';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const net = currentNetwork();
  const env = runtimeEnv(locals);
  const koiosToken = (env.KOIOS_API_KEY as string | undefined) || undefined;
  const koios = createKoiosClient({ baseUrl: net.koiosBaseUrl, token: koiosToken });

  return handleActionContext({ request, locals }, { koios, network: net, env });
};
