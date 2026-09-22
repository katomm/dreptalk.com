// GET /api/gov-action/status
// Whether gov-sync has picked up a just-submitted governance action yet, for
// the success screen's poll. All logic lives in handleActionStatus. This
// route only wires up the runtime env and delegates.
import type { APIRoute } from 'astro';
import { runtimeEnv, currentNetwork } from '@/lib/api/response';
import { handleActionStatus } from '@/lib/governance/actionStatusHandler';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const net = currentNetwork();
  const env = runtimeEnv(locals);
  return handleActionStatus({ request, locals }, { network: net, env });
};
