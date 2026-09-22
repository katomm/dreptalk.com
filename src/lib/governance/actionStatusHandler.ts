/// <reference types="@cloudflare/workers-types" />
// GET /api/gov-action/status: whether gov-sync has picked up a just-submitted
// governance action yet, for the success screen's poll (30 s interval, 10
// minute window, driven from successPolling.ts in the island). Read-only, no
// JWT, and the id is the same "<txHash>#<index>" key the island already shows
// on the success screen, so nothing here is guessable data a signed-in user
// could not already see.
import { jsonResponse, currentNetwork } from '@/lib/api/response.js';
import type { NetworkConfig } from '@/lib/config/network.js';
import { gateGovActionRequest, GOV_ACTION_RATE_POLICIES } from './govActionGate.js';
import { getDraftTopicRef } from '../db/draftLinks.js';

// The same "<64-hex-txHash>#<index>" shape links.ts and drepTx.ts validate,
// lowercase only since that is how the tx hash and the stored id are both
// written (see sync.ts, which keys governance_actions.id off proposal_tx_hash
// straight from Koios).
const GOV_ACTION_ID_RE = /^[0-9a-f]{64}#\d{1,5}$/;

export interface ActionStatusResponse {
  synced: boolean;
  slug: string | null;
  draft: { slug: string; title: string } | null;
}

export interface ActionStatusHandlerDeps {
  network?: NetworkConfig;
  env?: Cloudflare.Env;
}

/**
 * Handles GET /api/gov-action/status. `synced` is true only when the
 * governance_actions row exists and its topic_id is set: the sync writes the
 * row before the thread when the anchor is not readable yet (sync.ts), so a
 * row without a topic is not yet "on DRepTalk". `draft` is read through
 * draft_topic_id, which the sync only ever sets once topic_id is already set
 * (see buildDraftLinkStatements), so it never appears before `synced` does.
 */
export async function handleActionStatus(
  ctx: { request: Request; locals: App.Locals },
  deps: ActionStatusHandlerDeps = {},
): Promise<Response> {
  const net = deps.network ?? currentNetwork();
  const gate = await gateGovActionRequest(ctx, GOV_ACTION_RATE_POLICIES.status, {
    network: net,
    env: deps.env,
  });
  if (gate instanceof Response) return gate;
  const db = gate.db;

  const url = new URL(ctx.request.url);
  const id = url.searchParams.get('id');
  if (!id || !GOV_ACTION_ID_RE.test(id)) {
    return jsonResponse({ error: 'invalid id' }, 400, { 'cache-control': 'no-store' });
  }

  const row = await db
    .prepare(
      `SELECT g.topic_id AS topicId, g.draft_topic_id AS draftTopicId, t.slug AS slug
         FROM governance_actions g
         LEFT JOIN topics t ON t.id = g.topic_id AND t.deleted = 0
        WHERE g.id = ?`,
    )
    .bind(id)
    .first<{ topicId: string | null; draftTopicId: string | null; slug: string | null }>();

  if (!row) {
    const body: ActionStatusResponse = { synced: false, slug: null, draft: null };
    return jsonResponse(body, 200, { 'cache-control': 'no-store' });
  }

  const synced = row.topicId !== null;
  const draftRef = row.draftTopicId ? await getDraftTopicRef(db, row.draftTopicId) : null;
  const body: ActionStatusResponse = {
    synced,
    slug: row.slug,
    draft: draftRef ? { slug: draftRef.slug, title: draftRef.title } : null,
  };
  return jsonResponse(body, 200, { 'cache-control': 'no-store' });
}
