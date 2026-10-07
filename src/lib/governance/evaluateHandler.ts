/// <reference types="@cloudflare/workers-types" />
// POST /api/gov-action/evaluate: the Plutus evaluation of a treasury
// withdrawal's guardrail check, run through Koios /ogmios with the server's
// Koios token. Session gated like every gov-action route and narrow on
// purpose: the public Koios proxy stays read-only and unfiltered, so this is
// the one place DRepTalk evaluates a script, and checkEvaluableTx keeps it to
// the constitution's guardrails script alone.
import { ScriptHash, Transaction } from '@evolution-sdk/evolution';
import type { NetworkConfig } from '@/lib/config/network.js';
import { currentNetwork, jsonResponse } from '@/lib/api/response.js';
import { readBodyLimited } from '@/lib/http/bodyLimit.js';
import { gateGovActionRequest, GOV_ACTION_RATE_POLICIES } from './govActionGate.js';
import { govActionSubmissionAvailable, govActionTypeAvailable } from './submissionGate.js';
import { GUARDRAIL_SCRIPT_HASH_HEX } from './guardrailScript.js';
import { mapOgmiosEvaluation } from './evaluateContract.js';

/** A maximum transaction is 16,384 bytes, 32,768 hex characters, plus the JSON wrapper. */
export const EVALUATE_BODY_MAX_BYTES = 40 * 1024;

const UPSTREAM_TIMEOUT_MS = 15_000;
const NO_STORE = { 'cache-control': 'no-store' };

export interface EvaluateHandlerDeps {
  network?: NetworkConfig;
  env?: Cloudflare.Env;
  koiosBaseUrl: string;
  koiosToken?: string;
  /** Injectable for tests, defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Whether a decoded transaction may be evaluated here: it proposes something,
 * every redeemer is a propose redeemer, every proposal's policy hash is null
 * or the guardrail, and every Plutus script in the witness set is the
 * guardrail. Together that leaves the constitution's guardrails script as the
 * only script Ogmios can run for it.
 */
export function checkEvaluableTx(
  tx: Transaction.Transaction,
): { ok: true } | { ok: false; error: 'no_proposals' | 'foreign_policy_hash' | 'non_propose_redeemer' | 'foreign_script' } {
  const proposals = tx.body.proposalProcedures?.procedures ?? [];
  if (proposals.length === 0) return { ok: false, error: 'no_proposals' };
  for (const proposal of proposals) {
    const action = proposal.governanceAction;
    if (action._tag === 'TreasuryWithdrawalsAction' || action._tag === 'ParameterChangeAction') {
      if (action.policyHash !== null && ScriptHash.toHex(action.policyHash) !== GUARDRAIL_SCRIPT_HASH_HEX) {
        return { ok: false, error: 'foreign_policy_hash' };
      }
    }
  }
  const redeemers = tx.witnessSet.redeemers?.toArray() ?? [];
  if (redeemers.some((redeemer) => redeemer.tag !== 'propose')) return { ok: false, error: 'non_propose_redeemer' };
  const scripts = [
    ...(tx.witnessSet.plutusV1Scripts ?? []),
    ...(tx.witnessSet.plutusV2Scripts ?? []),
    ...(tx.witnessSet.plutusV3Scripts ?? []),
  ];
  for (const script of scripts) {
    if (ScriptHash.toHex(ScriptHash.fromScript(script)) !== GUARDRAIL_SCRIPT_HASH_HEX) {
      return { ok: false, error: 'foreign_script' };
    }
  }
  return { ok: true };
}

/**
 * Handles POST /api/gov-action/evaluate. Order: the shared gate (evaluate
 * policy), the type's availability (404 on mainnet), the body cap (413), the
 * body shape and the decode (400), the transaction checks (400), then one
 * upstream call whose every outcome maps to the typed contract in
 * evaluateContract.ts. Nothing here throws past the route.
 */
export async function handleEvaluate(
  ctx: { request: Request; locals: App.Locals },
  deps: EvaluateHandlerDeps,
): Promise<Response> {
  const net = deps.network ?? currentNetwork();
  const gate = await gateGovActionRequest(ctx, GOV_ACTION_RATE_POLICIES.evaluate, { network: net, env: deps.env });
  if (gate instanceof Response) return gate;
  const availability = { submissionAvailable: govActionSubmissionAvailable(net.network), network: net.network };
  if (!govActionTypeAvailable('TreasuryWithdrawals', availability)) return new Response('Not found', { status: 404 });

  const declared = Number(ctx.request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > EVALUATE_BODY_MAX_BYTES) {
    return jsonResponse({ error: 'body_too_large' }, 413, NO_STORE);
  }
  const read = await readBodyLimited(ctx.request.body, EVALUATE_BODY_MAX_BYTES);
  if (!read.ok) return jsonResponse({ error: 'body_too_large' }, 413, NO_STORE);

  // Lowercase hex only, which is what Transaction.toCBORHex writes on the client.
  let txCborHex: string;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(read.bytes)) as { txCborHex?: unknown } | null;
    const candidate = parsed?.txCborHex;
    if (typeof candidate !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(candidate)) {
      return jsonResponse({ error: 'invalid_body' }, 400, NO_STORE);
    }
    txCborHex = candidate;
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400, NO_STORE);
  }

  let tx: Transaction.Transaction;
  try {
    tx = Transaction.fromCBORHex(txCborHex);
  } catch {
    return jsonResponse({ error: 'invalid_transaction' }, 400, NO_STORE);
  }
  const check = checkEvaluableTx(tx);
  if (!check.ok) return jsonResponse({ error: check.error }, 400, NO_STORE);

  const fetchImpl = deps.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${deps.koiosBaseUrl}/ogmios`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(deps.koiosToken ? { authorization: `Bearer ${deps.koiosToken}` } : {}),
      },
      // The original bytes, unchanged: what was checked above is what is evaluated.
      // An empty additionalUtxo, the same body shape the SDK's Koios evaluator
      // sends: Ogmios resolves the inputs from the chain, so an input Koios has
      // not seen yet fails as CannotCreateEvaluationContext (3004,
      // evaluator_unavailable). An assumption the live test and the E2E check.
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'evaluateTransaction',
        params: { transaction: { cbor: txCborHex }, additionalUtxo: [] },
        id: null,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    console.error('[gov-action] evaluate: upstream request failed', err);
    return jsonResponse({ error: 'evaluator_unavailable' }, 503, NO_STORE);
  }

  let body: unknown = null;
  try {
    body = await upstream.json();
  } catch {
    body = null;
  }
  // A 5xx is the evaluator's own trouble even when it carries a JSON-RPC error.
  const mapped = upstream.status >= 500 ? null : mapOgmiosEvaluation(body);
  if (mapped === null) {
    console.error('[gov-action] evaluate: unusable upstream answer', upstream.status);
    return jsonResponse({ error: 'evaluator_unavailable' }, 503, NO_STORE);
  }
  if ('error' in mapped) return jsonResponse(mapped, 422, NO_STORE);
  if (!upstream.ok) return jsonResponse({ error: 'evaluator_unavailable' }, 503, NO_STORE);
  return jsonResponse(mapped, 200, NO_STORE);
}
