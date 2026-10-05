// POST /api/gov-action/metadata
// Finalizes an InfoAction CIP-108 metadata submission: verifies the optional
// author witness, pins the exact bytes to IPFS, and stores an audit row.
// preprod-only for now (mainnet is not wired up yet), so this and `prepare`
// share the gov-action gate (network, origin, session, bindings, IPFS secret,
// rate limit) before either handler is called. Both routes enforce the gate
// independently since they can be hit directly, not just through the
// (also-gated) submit page.
import type { APIRoute } from 'astro';
import { jsonResponse } from '@/lib/api/response';
import { handleInfoActionMetadata } from '@/lib/governance/infoActionMetadataHandler';
import { gateGovActionRequest, GOV_ACTION_RATE_POLICIES } from '@/lib/governance/govActionGate';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await gateGovActionRequest({ request, locals }, GOV_ACTION_RATE_POLICIES.metadata);
  if (gate instanceof Response) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const result = await handleInfoActionMetadata({
    body,
    db: gate.db,
    // requireJwt: true on the metadata policy, so jwt is never null here.
    jwt: gate.jwt as string,
    groupId: gate.groupId,
    now: Date.now(),
    expectedNetworkId: gate.networkId,
  });
  return jsonResponse(result.json, result.status);
};
