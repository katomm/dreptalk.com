/// <reference types="@cloudflare/workers-types" />
// Standalone cron worker: two triggers share this handler.
//   */15 * * * *  pulls on-chain governance actions from Koios and opens one
//                 system thread per new action (fast, low-volume).
//   0 */6 * * *   enumerates every registered DRep and persists profile data
//                 (heavier, runs every 6 hours).
// Shares the app's D1 database.
//
// Deployed separately from the Pages/Workers app (see
// .github/workflows/deploy-workers.yml); merging app code does NOT deploy this.

import { resolveNetwork } from '../../../src/lib/config/network.js';
import { createKoiosClient } from '../../../src/lib/koios/client.js';
import { bytesToHex } from '../../../src/lib/crypto/hex.js';
import { syncGovernanceActions, type SyncResult } from '../../../src/lib/governance/sync.js';
import { syncDreps, type DrepSyncResult } from '../../../src/lib/dreps/sync.js';

interface Env {
  DB: D1Database;
  CARDANO_NETWORK?: string;
  KOIOS_API_KEY?: string;
}

/** Short random hex for topic slug suffixes. */
function randSuffix(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(4)));
}

/** Resolves the network and a Koios client from env bindings. Shared by both paths. */
function buildKoios(env: Env) {
  const { network, koiosBaseUrl } = resolveNetwork(env.CARDANO_NETWORK ?? null);
  const koios = createKoiosClient({ baseUrl: koiosBaseUrl, token: env.KOIOS_API_KEY || undefined });
  return { koios, network };
}

async function runGovernanceSync(env: Env): Promise<SyncResult> {
  const { koios, network } = buildKoios(env);
  return syncGovernanceActions({
    koios,
    db: env.DB,
    network,
    now: Date.now(),
    rand: randSuffix,
  });
}

async function runDrepSync(env: Env): Promise<DrepSyncResult> {
  const { koios } = buildKoios(env);
  return syncDreps({ koios, db: env.DB, fetchImpl: fetch, now: Date.now() });
}

// The cron expression that triggers the DRep sync (every 6 hours on the hour).
const DREP_SYNC_CRON = '0 */6 * * *';

export default {
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Await the sync directly: it is the handler's whole job, so the runtime
    // should keep the invocation alive until it finishes (and `wrangler dev
    // --test-scheduled` only returns once it resolves).
    if (event.cron === DREP_SYNC_CRON) {
      try {
        const r = await runDrepSync(env);
        console.log(
          `[drep-sync] total=${r.total} updated=${r.updated} skipped=${r.skipped} anchorsFetched=${r.anchorsFetched} failed=${r.failed}`,
        );
      } catch (err) {
        console.error('[drep-sync] run failed', err);
      }
    } else {
      // Default: governance-action sync (*/15 * * * *).
      try {
        const r = await runGovernanceSync(env);
        console.log(`[gov-sync] total=${r.total} created=${r.created} skipped=${r.skipped} failed=${r.failed}`);
      } catch (err) {
        console.error('[gov-sync] run failed', err);
      }
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
