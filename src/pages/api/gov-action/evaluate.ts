// POST /api/gov-action/evaluate
// Evaluates a treasury withdrawal's guardrail check through Koios /ogmios
// with the server's Koios token. All logic lives in handleEvaluate. This
// route only wires up the runtime network and token and delegates.
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { handleEvaluate } from '@/lib/governance/evaluateHandler';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const net = currentNetwork();
  const env = runtimeEnv(locals);
  const koiosToken = (env.KOIOS_API_KEY as string | undefined) || undefined;
  return handleEvaluate({ request, locals }, { network: net, env, koiosBaseUrl: net.koiosBaseUrl, koiosToken });
};
