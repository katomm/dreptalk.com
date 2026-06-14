/// <reference types="@cloudflare/workers-types" />
// Standalone cron worker: three triggers share this handler, dispatched on
// event.cron against the constants in src/lib/freshness.js (kept in sync with
// wrangler.toml's `crons`).
//   */15 * * * *  discover governance actions + refresh active-action tallies.
//   0 * * * *     refresh the larger per-post vote lists (active actions only).
//   0 */6 * * *   enumerate every registered DRep and persist profile data.
// Shares the app's D1 database.
//
// Every run is recorded in the sync_runs table via recordSyncRun: each pass is
// a phase that fails in isolation (a Koios hiccup in one pass no longer skips
// the rest), and the run row carries ok/partial/error plus per-phase outcomes
// for the /debug/sync page.
//
// Deployed separately from the app via Cloudflare Workers Builds, whose build
// trigger only watches this directory (workers/gov-sync/**). This worker bundles
// shared logic from src/lib at build time, but changes under src/lib do NOT match
// the watch path, so editing the bundled governance/sync logic alone leaves the
// cron running the old bundle. A change here (even a comment) is required to
// trigger a redeploy that picks up new src/lib code.

import { resolveNetwork } from '../../../src/lib/config/network.js';
import { createKoiosClient } from '../../../src/lib/koios/client.js';
import { bytesToHex } from '../../../src/lib/crypto/hex.js';
import { CRON_VOTE_SYNC, CRON_DREP_SYNC } from '../../../src/lib/freshness.js';
import {
  syncGovernanceActions,
  backfillActionMetadata,
  backfillGovTopicSubmittedAt,
  refreshTrendingScores,
} from '../../../src/lib/governance/sync.js';
import { syncGovernanceTallies, syncGovernanceVotes, backfillVotedPower, backfillFinalizedVotes } from '../../../src/lib/governance/tallySync.js';
import { syncDreps, backfillRegisteredEpochs, backfillDrepSlugs } from '../../../src/lib/dreps/sync.js';
import { awardBadges } from '../../../src/lib/badges/engine.js';
import { storeDrepAvatars, gcDrepAvatars } from '../../../src/lib/dreps/avatarStore.js';
import { upsertProtocolParams, getProtocolParams } from '../../../src/lib/db/protocolParams.js';
import { recordSyncRun, type PhaseFn } from '../../../src/lib/sync/runRecorder.js';

interface Env {
  DB: D1Database;
  AVATARS?: R2Bucket;
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
  // proposal_voting_summary / proposal_votes are heavy aggregations that can take
  // 10-25s when Koios is under load. The default 10s timeout drops them and the
  // action never syncs, so wait longer here and retry transient failures with
  // exponential backoff (500ms then 1s, plus any server-sent Retry-After). The
  // per-run limits below bound the worst-case wall time.
  const koios = createKoiosClient({
    baseUrl: koiosBaseUrl,
    token: env.KOIOS_API_KEY || undefined,
    timeoutMs: 25_000,
    retries: 2,
    retryDelayMs: 500,
  });
  return { koios, network };
}

// Per-run tally budget: each run tallies at most this many (stale-first), paced
// apart, and the backlog drains over a few runs. Kept small so that even when
// every Koios call runs to the 25s timeout the run stays well within cron limits.
const TALLY_LIMIT = 12;
const TALLY_PACE_MS = 200;

// Per-run vote-sync budget: proposal_votes is paginated and heavier than the tally
// summary, so the hourly vote sync is bounded and paced the same way.
const VOTE_LIMIT = 12;
const VOTE_PACE_MS = 200;

// Per-run anchor-fetch budget for the DRep sync. The first sync from an empty
// database would otherwise fetch every DRep's CIP-119 anchor in one invocation
// and blow the Workers subrequest limit; with the budget, the backlog drains
// over a few 6-hour runs (deferred anchors resume automatically). Steady-state
// runs fetch only changed anchors and never come near the cap.
const DREP_ANCHOR_LIMIT = 400;

// Discover new actions, then refresh tallies + lifecycle for active actions.
async function runGovernanceSync(env: Env, phase: PhaseFn): Promise<void> {
  const { koios, network } = buildKoios(env);
  const now = Date.now();

  await phase('discovery', async () => {
    const disc = await syncGovernanceActions({ koios, db: env.DB, network, now, rand: randSuffix });
    console.log(`[gov-sync] total=${disc.total} created=${disc.created} skipped=${disc.skipped} failed=${disc.failed}`);
    return { items: disc.total, failed: disc.failed };
  }, { primary: true });

  // The tip lookup lives inside the tally phase: tallies are its only consumer,
  // so a tip failure surfaces as a failed tallies phase, not a failed discovery.
  await phase('tallies', async () => {
    const tip = await koios.tip();
    const tally = await syncGovernanceTallies({
      koios,
      db: env.DB,
      currentEpoch: tip.epoch_no,
      now,
      limit: TALLY_LIMIT,
      paceMs: TALLY_PACE_MS,
    });
    console.log(`[gov-tally] active=${tally.active} updated=${tally.updated} frozen=${tally.frozen} failed=${tally.failed}`);
    return { items: tally.updated, failed: tally.failed };
  });

  await phase('voted-power', async () => {
    const backfill = await backfillVotedPower({ koios, db: env.DB, limit: 25 });
    console.log(`[gov-backfill] scanned=${backfill.scanned} updated=${backfill.updated} failed=${backfill.failed}`);
    return { items: backfill.updated, failed: backfill.failed };
  });

  await phase('metadata', async () => {
    const metaBackfill = await backfillActionMetadata({ db: env.DB, now: Date.now(), fetchImpl: fetch, limit: 10 });
    console.log(`[gov-meta-backfill] scanned=${metaBackfill.scanned} updated=${metaBackfill.updated} failed=${metaBackfill.failed}`);
    return { items: metaBackfill.updated, failed: metaBackfill.failed };
  });

  // Correct post dates for existing no-reply governance topics (sync-time -> submission
  // time). Idempotent: a no-op once corrected. The whole backlog is low hundreds, so
  // one generous limit drains it in a single run.
  await phase('post-dates', async () => {
    const postDate = await backfillGovTopicSubmittedAt({ db: env.DB, network, limit: 500 });
    console.log(`[gov-postdate-backfill] scanned=${postDate.scanned} updated=${postDate.updated}`);
    return { items: postDate.updated };
  });

  // Last: recompute the materialized trending sort key so the list page can order and
  // page in the database. Runs after discovery, tallies, and the post-date backfill so
  // it folds in everything this run changed. Only-changed writes; a no-op once settled.
  await phase('trending', async () => {
    const trending = await refreshTrendingScores({ db: env.DB });
    console.log(`[gov-trending] scanned=${trending.scanned} updated=${trending.updated}`);
    return { items: trending.updated };
  });

  // Refresh the cached CIP-1694 voting thresholds + committee quorum (used by the
  // GA detail Voting Information card). Changes only via governance, so this is a
  // cheap once-per-run call with an only-changed write.
  await phase('params', async () => {
    const [ep, ccq] = await Promise.all([koios.epochParams(), koios.committeeQuorum()]);
    if (!ep) return { items: 0 };
    const next = {
      epoch: ep.epoch_no ?? null,
      dvtMotionNoConfidence: ep.dvt_motion_no_confidence ?? null,
      dvtCommitteeNormal: ep.dvt_committee_normal ?? null,
      dvtCommitteeNoConfidence: ep.dvt_committee_no_confidence ?? null,
      dvtUpdateConstitution: ep.dvt_update_to_constitution ?? null,
      dvtHardFork: ep.dvt_hard_fork_initiation ?? null,
      dvtPpNetwork: ep.dvt_p_p_network_group ?? null,
      dvtPpEconomic: ep.dvt_p_p_economic_group ?? null,
      dvtPpTechnical: ep.dvt_p_p_technical_group ?? null,
      dvtPpGov: ep.dvt_p_p_gov_group ?? null,
      dvtTreasuryWithdrawal: ep.dvt_treasury_withdrawal ?? null,
      pvtMotionNoConfidence: ep.pvt_motion_no_confidence ?? null,
      pvtCommitteeNormal: ep.pvt_committee_normal ?? null,
      pvtCommitteeNoConfidence: ep.pvt_committee_no_confidence ?? null,
      pvtHardFork: ep.pvt_hard_fork_initiation ?? null,
      pvtSecurityGroup: ep.pvtpp_security_group ?? null,
      ccThreshold: ccq,
      committeeMinSize: ep.committee_min_size ?? null,
      syncedAt: now,
    };
    const cur = await getProtocolParams(env.DB);
    let written = 0;
    if (
      !cur ||
      cur.epoch !== next.epoch ||
      cur.dvtTreasuryWithdrawal !== next.dvtTreasuryWithdrawal ||
      cur.ccThreshold !== next.ccThreshold
    ) {
      await upsertProtocolParams(env.DB, next);
      written = 1;
    }
    console.log(`[gov-params] epoch=${next.epoch} treasury=${next.dvtTreasuryWithdrawal} cc=${next.ccThreshold}`);
    return { items: written };
  });
}

// Refresh the per-post vote lists (active actions only). Hourly: vote lists are
// larger and per-post badges do not need 15-minute freshness. Per-action vote
// pagination is bounded (see MAX_VOTE_PAGES in tallySync) so one action with a
// pathologically long vote list cannot run this invocation out of CPU and leave
// the run stuck mid-loop.
async function runVoteSync(env: Env, phase: PhaseFn): Promise<void> {
  const { koios } = buildKoios(env);
  const now = Date.now();

  await phase('votes', async () => {
    const r = await syncGovernanceVotes({ koios, db: env.DB, now, limit: VOTE_LIMIT, paceMs: VOTE_PACE_MS });
    console.log(`[gov-votes] actions=${r.actions} votes=${r.votes} failed=${r.failed}`);
    return { items: r.votes, failed: r.failed };
  }, { primary: true });

  // One-time historical fill for finalised actions never vote-synced. Small,
  // paced budget so the hourly run stays light; drains over many hours.
  await phase('finalized-backfill', async () => {
    const bf = await backfillFinalizedVotes({ koios, db: env.DB, now, limit: 6, paceMs: VOTE_PACE_MS });
    console.log(`[gov-votes-backfill] actions=${bf.actions} votes=${bf.votes} failed=${bf.failed}`);
    return { items: bf.votes, failed: bf.failed };
  });

  // Award achievement badges from the freshly synced data: a set-based full
  // pass over D1 (no Koios calls) that writes only new awards and tier upgrades.
  await phase('badges', async () => {
    const cfg = resolveNetwork(env.CARDANO_NETWORK ?? null);
    const badges = await awardBadges({ db: env.DB, cfg, now: Date.now() });
    console.log(`[badges] desired=${badges.desired} written=${badges.written}`);
    return { items: badges.written };
  });
}

async function runDrepSync(env: Env, phase: PhaseFn): Promise<void> {
  const { koios } = buildKoios(env);

  await phase('dreps', async () => {
    const r = await syncDreps({
      koios, db: env.DB, fetchImpl: fetch, now: Date.now(), maxAnchorFetches: DREP_ANCHOR_LIMIT,
    });
    console.log(
      `[drep-sync] total=${r.total} updated=${r.updated} skipped=${r.skipped} ` +
        `anchorsFetched=${r.anchorsFetched} anchorsDeferred=${r.anchorsDeferred} failed=${r.failed}`,
    );
    return { items: r.total, failed: r.failed };
  }, { primary: true });

  // Backfill registration epochs for any DReps still missing one (drives the
  // participation stat). No-op once all are filled; only new DReps cost a page.
  await phase('registered-epochs', async () => {
    const cfg = resolveNetwork(env.CARDANO_NETWORK ?? null);
    const reg = await backfillRegisteredEpochs({ koios, db: env.DB, cfg });
    console.log(`[drep-reg-backfill] missing=${reg.missing} resolved=${reg.resolved} pages=${reg.pages}`);
    return { items: reg.resolved };
  });

  // Mint profile slugs for newly named DReps (pure D1, no Koios). A profile
  // without a slug simply keeps its id URL until the next run.
  await phase('slugs', async () => {
    const slugs = await backfillDrepSlugs(env.DB);
    if (slugs.missing > 0) console.log(`[drep-slugs] missing=${slugs.missing} assigned=${slugs.assigned}`);
    return { items: slugs.assigned };
  });

  // Store new/changed avatars in R2 and GC orphaned objects. A failure here
  // must not fail the DRep sync that already succeeded (phase isolation).
  if (env.AVATARS) {
    const bucket = env.AVATARS;
    // Avatar fetches give up on a source after AVATAR_FETCH_MAX_ATTEMPTS failures
    // (see avatarStore), so a permanently broken image stops being retried every
    // run instead of pinning this sync at 'partial' forever.
    await phase('avatars', async () => {
      const a = await storeDrepAvatars({ db: env.DB, bucket, fetchImpl: fetch });
      console.log(`[drep-avatars] scanned=${a.scanned} stored=${a.stored} cleared=${a.cleared} failed=${a.failed}`);
      const gc = await gcDrepAvatars({ db: env.DB, bucket, nowMs: Date.now() });
      console.log(`[drep-avatars-gc] scanned=${gc.scanned} deleted=${gc.deleted}`);
      return { items: a.stored, failed: a.failed };
    });
  } else {
    console.warn('[drep-avatars] AVATARS binding missing; skipping avatar store');
  }
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Await the sync directly: it is the handler's whole job, so the runtime
    // keeps the invocation alive until it finishes (and `wrangler dev
    // --test-scheduled` only returns once it resolves).
    try {
      const [kind, run] =
        event.cron === CRON_DREP_SYNC
          ? (['dreps', runDrepSync] as const)
          : event.cron === CRON_VOTE_SYNC
            ? (['votes', runVoteSync] as const)
            : (['governance', runGovernanceSync] as const);
      const summary = await recordSyncRun(env.DB, kind, (phase) => run(env, phase));
      console.log(
        `[sync-run] kind=${kind} status=${summary.status} items=${summary.items} failed=${summary.failed}` +
          (summary.error ? ` error=${summary.error}` : ''),
      );
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
