// POST /api/gov-action/metadata/prepare
// Returns the canonical CIP-108 body hash the client signs as an author
// witness before the finalize call. Shares every gate with `../metadata`
// (preprod-only, same-origin, session, bindings, IPFS secret, rate limit) so
// this route is safe to call directly.
import type { APIRoute } from 'astro';
import { jsonResponse } from '@/lib/api/response';
import { gateInfoActionRequest } from '../metadata';
import { prepareInfoActionBodyHash } from '@/lib/governance/infoActionMetadataHandler';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await gateInfoActionRequest({ request, locals });
  if (gate instanceof Response) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const result = await prepareInfoActionBodyHash(body);
  return jsonResponse(result.json, result.status);
};
