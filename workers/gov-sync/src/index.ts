/// <reference types="@cloudflare/workers-types" />
// Standalone cron worker: three triggers share this handler, dispatched on
// event.cron against the constants in src/lib/freshness.js (kept in sync with
// wrangler.toml's `crons`).
//   */15 * * * *  discover governance actions + refresh active-action tallies.
//   0 * * * *     refresh the larger per-post vote lists (active actions only).
//   0 */6 * * *   enumerate every registered DRep and persist profile data.
// Shares the app's D1 database.
//
// Deployed separately from the Pages/Workers app (see
// .github/workflows/deploy-workers.yml); merging app code does NOT deploy this.

import { resolveNetwork } from '../../../src/lib/config/network.js';
import { createKoiosClient } from '../../../src/lib/koios/client.js';
import { bytesToHex } from '../../../src/lib/crypto/hex.js';
import { CRON_VOTE_SYNC, CRON_DREP_SYNC } from '../../../src/lib/freshness.js';
import { syncGovernanceActions, backfillActionMetadata } from '../../../src/lib/governance/sync.js';
import { syncGovernanceTallies, syncGovernanceVotes, backfillVotedPower } from '../../../src/lib/governance/tallySync.js';
import { syncDreps } from '../../../src/lib/dreps/sync.js';

interface Env {
  DB: D1Database;
  CARDANO_NETWORK?: string;
  KOIOS_API_KEY?: string;
}

/** Short random hex for topic slug suffixes. */
function randSuffix(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(4)));
}

/** Resolves the network and a Koios client from env bindings. Shared by all paths. */
function buildKoios(env: Env) {
  const { network, koiosBaseUrl } = resolveNetwork(env.CARDANO_NETWORK ?? null);
  // Retry transient Koios failures: proposal_voting_summary 504s/times-out under
  // load, and a dropped call silently leaves an action unsynced.
  const koios = createKoiosClient({
    baseUrl: koiosBaseUrl,
    token: env.KOIOS_API_KEY || undefined,
    retries: 2,
    retryDelayMs: 300,
  });
  return { koios, network };
}

// Per-run tally budget: Koios cannot serve a summary call for every syncable
// action in one burst, so each run tallies at most this many (stale-first), paced
// apart, and the backlog drains over a few runs.
const TALLY_LIMIT = 15;
const TALLY_PACE_MS = 200;

// Discover new actions, then refresh tallies + lifecycle for active actions.
async function runGovernanceSync(env: Env): Promise<void> {
  const { koios, network } = buildKoios(env);
  const now = Date.now();

  // Discovery and the tip lookup are independent; run them together.
  const [disc, tip] = await Promise.all([
    syncGovernanceActions({ koios, db: env.DB, network, now, rand: randSuffix }),
    koios.tip(),
  ]);
  console.log(`[gov-sync] total=${disc.total} created=${disc.created} skipped=${disc.skipped} failed=${disc.failed}`);

  const tally = await syncGovernanceTallies({
    koios,
    db: env.DB,
    currentEpoch: tip.epoch_no,
    now,
    limit: TALLY_LIMIT,
    paceMs: TALLY_PACE_MS,
  });
  console.log(`[gov-tally] active=${tally.active} updated=${tally.updated} frozen=${tally.frozen} failed=${tally.failed}`);

  const backfill = await backfillVotedPower({ koios, db: env.DB, limit: 25 });
  console.log(`[gov-backfill] scanned=${backfill.scanned} updated=${backfill.updated} failed=${backfill.failed}`);

  const metaBackfill = await backfillActionMetadata({ db: env.DB, now: Date.now(), fetchImpl: fetch, limit: 10 });
  console.log(`[gov-meta-backfill] scanned=${metaBackfill.scanned} updated=${metaBackfill.updated} failed=${metaBackfill.failed}`);
}

// Refresh the per-post vote lists (active actions only). Hourly: vote lists are
// larger and per-post badges do not need 15-minute freshness.
async function runVoteSync(env: Env): Promise<void> {
  const { koios } = buildKoios(env);
  const r = await syncGovernanceVotes({ koios, db: env.DB, now: Date.now() });
  console.log(`[gov-votes] actions=${r.actions} votes=${r.votes} failed=${r.failed}`);
}

async function runDrepSync(env: Env): Promise<void> {
  const { koios } = buildKoios(env);
  const r = await syncDreps({ koios, db: env.DB, fetchImpl: fetch, now: Date.now() });
  console.log(
    `[drep-sync] total=${r.total} updated=${r.updated} skipped=${r.skipped} anchorsFetched=${r.anchorsFetched} failed=${r.failed}`,
  );
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Await the sync directly: it is the handler's whole job, so the runtime
    // keeps the invocation alive until it finishes (and `wrangler dev
    // --test-scheduled` only returns once it resolves).
    try {
      if (event.cron === CRON_DREP_SYNC) {
        await runDrepSync(env);
      } else if (event.cron === CRON_VOTE_SYNC) {
        await runVoteSync(env);
      } else {
        // Default: the */15 governance discovery + tally cycle.
        await runGovernanceSync(env);
      }
    } catch (err) {
      console.error(`[gov-sync] scheduled run failed (cron=${event.cron})`, err);
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
