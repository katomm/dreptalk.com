// GET /api/pool-economics
// Stored pool distribution, public and same-origin. All logic lives in
// handlePublicPoolEconomics.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { handlePublicPoolEconomics } from '@/lib/governance/poolEconomicsHandler';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  return handlePublicPoolEconomics({ request, locals }, { env: runtimeEnv(locals) });
};
