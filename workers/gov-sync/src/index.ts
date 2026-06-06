/// <reference types="@cloudflare/workers-types" />
// Standalone cron worker: pulls on-chain governance actions from Koios and opens
// one system thread per new action. Shares the app's D1 database.
//
// Deployed separately from the Pages/Workers app (see
// .github/workflows/deploy-workers.yml); merging app code does NOT deploy this.

import { resolveNetwork } from '../../../src/lib/config/network.js';
import { createKoiosClient } from '../../../src/lib/koios/client.js';
import { syncGovernanceActions, type SyncResult } from '../../../src/lib/governance/sync.js';

interface Env {
  DB: D1Database;
  CARDANO_NETWORK?: string;
  KOIOS_API_KEY?: string;
}

/** Short random hex for topic slug suffixes. */
function randSuffix(): string {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

async function runSync(env: Env): Promise<SyncResult> {
  const { network, koiosBaseUrl } = resolveNetwork(env.CARDANO_NETWORK ?? null);
  const koios = createKoiosClient({ baseUrl: koiosBaseUrl, token: env.KOIOS_API_KEY || undefined });
  return syncGovernanceActions({
    koios,
    db: env.DB,
    network,
    now: Date.now(),
    rand: randSuffix,
  });
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Await the sync directly: it is the handler's whole job, so the runtime
    // should keep the invocation alive until it finishes (and `wrangler dev
    // --test-scheduled` only returns once it resolves).
    try {
      const r = await runSync(env);
      console.log(`[gov-sync] total=${r.total} created=${r.created} skipped=${r.skipped} failed=${r.failed}`);
    } catch (err) {
      console.error('[gov-sync] run failed', err);
    }
  },

  // The cron drives scheduled() in production. This handler only reports health;
  // it deliberately does not run a sync, so there is no unauthenticated trigger.
  // Locally, use `wrangler dev --test-scheduled` and hit /__scheduled.
  async fetch(): Promise<Response> {
    return new Response('dreptalk gov-sync worker: scheduled cron only.\n', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
