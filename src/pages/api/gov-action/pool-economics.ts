// GET /api/gov-action/pool-economics
// Stored pool distribution for the parameter change impact panels. All logic
// lives in handlePoolEconomics.
import type { APIRoute } from 'astro';
import { runtimeEnv, currentNetwork } from '@/lib/api/response';
import { handlePoolEconomics } from '@/lib/governance/poolEconomicsHandler';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  return handlePoolEconomics({ request, locals }, { network: currentNetwork(), env: runtimeEnv(locals) });
};
