/// <reference types="@cloudflare/workers-types" />
// Standalone cron worker: three triggers share this handler, dispatched on
// event.cron against the constants in src/lib/freshness.js (kept in sync with
// wrangler.toml's `crons`).
//   */15 * * * *  discover governance actions + refresh active-action tallies.
//   */20 * * * *  refresh the larger per-post vote lists (active actions only).
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
//
// Redeploy markers (touch this file to pick up the named src/lib change):
//   2026-06-20: ship the governance_actions.submitted_at writer + backfill so the
//               "new" sort orders by exact on-chain submission time.
//   2026-06-21: ship the DRep sync deactivation pass so deregistered DReps stop
//               showing as active with frozen voting power.
//   2026-06-23: vote sync orders by votes_synced_at (not tally recency) and the
//               budget covers the full active set, so per-post vote lists stop
//               lagging hours behind; vote cron moved hourly -> every 20 min.
//   2026-06-25: re-fetch governance anchors that failed at discovery (previously
//               stamped current-version and never retried), and add a gov-titles phase
//               that reconciles topic titles + opening posts with the recovered action
//               title (also fixes older action-only recoveries).
//   2026-06-27: keep re-checking ratified actions until Koios sets enacted_epoch, so
//               an action frozen during the ~1-epoch ratified window flips to "Enacted"
//               instead of staying stuck on "Ratified".
//   2026-06-27: date gov_status feed events at their on-chain epoch boundary (not
//               detection time) + add a gov-status-times backfill that re-dates the
//               catch-up burst of "was enacted" events to when they actually enacted.
//   2026-06-30: stop the avatar pass from wiping inline data: URI DRep avatars
//               (clearOrphanedImageStore now spares rows with no stored source URL).
//   2026-07-01: pick up META_EXTRACT_VERSION 3 so the metadata backfill re-extracts
//               action bodies with motivation + rationale merged (was dropping the
//               motivation section, cutting the body off at the start).
//   2026-07-02: params phase also syncs the active committee size, so the CC
//               quorum check runs on real membership instead of votes cast
//               (fixes false "Not met" on the detail page).

import { resolveNetwork } from '../../../src/lib/config/network.js';
import { createKoiosClient } from '../../../src/lib/koios/client.js';
import { activeCommitteeSize } from '../../../src/lib/koios/committee.js';
import { bytesToHex } from '../../../src/lib/crypto/hex.js';
import { CRON_VOTE_SYNC, CRON_DREP_SYNC } from '../../../src/lib/freshness.js';
import {
  syncGovernanceActions,
  backfillActionMetadata,
  backfillGovTopicSubmittedAt,
  backfillGovTopicTitles,
  refreshTrendingScores,
} from '../../../src/lib/governance/sync.js';
import { syncGovernanceTallies, syncGovernanceVotes, backfillVotedPower, backfillFinalizedVotes, backfillVoteMetaHashes, backfillGovStatusTimes, reconcilePendingVotes } from '../../../src/lib/governance/tallySync.js';
import { syncVoteRationales } from '../../../src/lib/governance/rationaleSync.js';
import { backfillRationaleText } from '../../../src/lib/db/rationaleTextBackfill.js';
import { syncDreps, backfillRegisteredEpochs, backfillDrepSlugs } from '../../../src/lib/dreps/sync.js';
import { syncDrepVotingPowerHistory } from '../../../src/lib/dreps/votingPowerHistorySync.js';
import { syncDrepDelegatorCounts } from '../../../src/lib/dreps/delegatorCountSync.js';
import { awardBadges } from '../../../src/lib/badges/engine.js';
import { storeDrepAvatars, gcDrepAvatars, imagesDownscaler, type ImagesLike } from '../../../src/lib/dreps/avatarStore.js';
import { syncPools } from '../../../src/lib/pools/sync.js';
import { storePoolAvatars } from '../../../src/lib/pools/avatarStore.js';
import { listReferencedPoolImageHashes } from '../../../src/lib/db/pools.js';
import { upsertProtocolParams, getProtocolParams } from '../../../src/lib/db/protocolParams.js';
import { syncCurrentCommitteeMembership, recomputeCommitteePct } from '../../../src/lib/db/committee.js';
import { deleteExpiredPending } from '../../../src/lib/db/pendingMultisigTx.js';
import { recordSyncRun, type PhaseFn } from '../../../src/lib/sync/runRecorder.js';

interface Env {
  DB: D1Database;
  AVATARS?: R2Bucket;
  IMAGES?: ImagesLike;
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
// summary, so the vote sync is bounded and paced the same way. Sized to cover the
// whole active set in one run (active actions currently number ~20), so that on
// the */20 cadence every active action's vote list refreshes each run rather than
// rotating a 12-wide window and leaving the tail hours stale.
const VOTE_LIMIT = 25;
const VOTE_PACE_MS = 200;

// Per-run anchor-fetch budget for the DRep sync. The first sync from an empty
// database would otherwise fetch every DRep's CIP-119 anchor in one invocation
// and blow the Workers subrequest limit; with the budget, the backlog drains
// over a few 6-hour runs (deferred anchors resume automatically). Steady-state
// runs fetch only changed anchors and never come near the cap.
const DREP_ANCHOR_LIMIT = 400;

// Delegator counts are one cheap Koios request each and Koios has no bulk form,
// so each run refreshes a bounded, stalest-first slice. The full set (~1,700
// DReps) cycles in ~1-2 days; raise this to shorten the cycle. Self-healing: a
// missed or failed DRep is simply picked up on a later run.
const DREP_DELEGATOR_COUNT_LIMIT = 300;

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
      network,
      limit: TALLY_LIMIT,
      paceMs: TALLY_PACE_MS,
    });
    console.log(`[gov-tally] active=${tally.active} updated=${tally.updated} frozen=${tally.frozen} reSynced=${tally.reSynced} failed=${tally.failed}`);
    return { items: tally.updated + tally.reSynced, failed: tally.failed };
  });

  // Re-date gov_status feed events to their on-chain epoch boundary when the stored
  // time drifted (e.g. a backlog of terminal transitions caught up in one run, which
  // would otherwise all read "just now"). Pure D1, only-changed; a no-op once settled.
  await phase('gov-status-times', async () => {
    const fixed = await backfillGovStatusTimes({ db: env.DB, network, limit: 500 });
    console.log(`[gov-status-times] scanned=${fixed.scanned} updated=${fixed.updated}`);
    return { items: fixed.updated };
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

  // Reconcile topic titles + opening posts with the (now-present) action title. Runs
  // after the metadata phase so a title recovered this run is propagated to its topic in
  // the same run. Pure D1, only-changed; a settled run writes nothing.
  await phase('gov-titles', async () => {
    const titles = await backfillGovTopicTitles({ db: env.DB, network, limit: 200 });
    console.log(`[gov-title-backfill] scanned=${titles.scanned} updated=${titles.updated}`);
    return { items: titles.updated };
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
    const [ep, cc] = await Promise.all([koios.epochParams(), koios.committeeSummary()]);
    if (!ep) return { items: 0 };
    const cur = await getProtocolParams(env.DB);
    // Treasury/reserves balances from a separate Koios endpoint. On a transient
    // failure, carry forward the currently-stored values instead of nulling them
    // out, since this upsert is a full-row replace.
    let totals: { epochNo: number; treasuryLovelace: string; reservesLovelace: string } | null = null;
    try {
      totals = await koios.totals();
    } catch (err) {
      console.error('[gov-params] totals fetch failed, keeping stored treasury values', err);
    }
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
      ccThreshold: cc.quorum,
      committeeMinSize: ep.committee_min_size ?? null,
      // Real committee size for the CIP-1694 min-size rule (null when Koios has
      // no committee row), from the same /committee_info call as the quorum.
      committeeSize:
        cc.members == null ? null : activeCommitteeSize(cc.members, ep.epoch_no ?? null),
      syncedAt: now,
      // Full epoch_params blob: the Overview's parameter old to new lookup reads
      // it (no extra Koios call). Stored verbatim so future keys need no schema change.
      rawJson: JSON.stringify(ep),
      // Fall back to the currently-stored balances when totals() came back null
      // or failed, so a transient Koios error never wipes them via this full-row upsert.
      treasuryLovelace: totals?.treasuryLovelace ?? cur?.treasuryLovelace ?? null,
      reservesLovelace: totals?.reservesLovelace ?? cur?.reservesLovelace ?? null,
      treasuryEpoch: totals?.epochNo ?? cur?.treasuryEpoch ?? null,
    };
    let written = 0;
    if (
      !cur ||
      cur.epoch !== next.epoch ||
      cur.dvtTreasuryWithdrawal !== next.dvtTreasuryWithdrawal ||
      cur.ccThreshold !== next.ccThreshold ||
      // Committee size comes from committee_info, not the epoch_params blob, so
      // rawJson comparison alone would miss membership changes (resignations).
      cur.committeeSize !== next.committeeSize ||
      cur.rawJson !== next.rawJson ||
      cur.treasuryLovelace !== next.treasuryLovelace ||
      cur.reservesLovelace !== next.reservesLovelace ||
      cur.treasuryEpoch !== next.treasuryEpoch
    ) {
      await upsertProtocolParams(env.DB, next);
      written = 1;
    }
    // Keep the committee membership timeline current from the same committee_info
    // snapshot: newly rotated hot keys and term changes feed the CC yes-percentage
    // recompute. Protected against overwriting the seeded resignation history.
    if (cc.members) {
      const cm = await syncCurrentCommitteeMembership(env.DB, cc.members, ep.epoch_no ?? null);
      if (cm.unknown > 0) {
        console.warn(`[gov-params] ${cm.unknown} committee member(s) not in the seeded timeline; a committee change may need seeding`);
      }
    }
    console.log(`[gov-params] epoch=${next.epoch} treasury=${next.dvtTreasuryWithdrawal} cc=${next.ccThreshold} ccSize=${next.committeeSize} treasuryLovelace=${next.treasuryLovelace}`);
    return { items: written };
  });
}

// Refresh the per-post vote lists (active actions only). Every 20 min: vote lists
// are larger than the tally summary, but the budget covers the whole active set
// in one run, so each active action's vote list refreshes every run. Per-action vote
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

  // Resolve stake-pool metadata (ticker/name/logo) for the pools that appear on
  // the platform, and mirror logos to R2. Runs here on the frequent cron (not
  // only the 6h DRep sync) so a large active-pool backlog drains in hours and
  // newly-active SPO pools appear within one cron cycle; a no-op once drained.
  await phase('pools', async () => {
    const r = await syncPools({ koios, db: env.DB, fetchImpl: fetch, nowMs: Date.now() });
    console.log(`[pools] scanned=${r.scanned} updated=${r.updated} logos=${r.logos}`);
    return { items: r.updated };
  });

  if (env.AVATARS) {
    const bucket = env.AVATARS;
    await phase('pool-avatars', async () => {
      const p = await storePoolAvatars({
        db: env.DB,
        bucket,
        fetchImpl: fetch,
        downscale: env.IMAGES ? imagesDownscaler(env.IMAGES) : undefined,
      });
      console.log(`[pool-avatars] scanned=${p.scanned} stored=${p.stored} cleared=${p.cleared} failed=${p.failed}`);
      return { items: p.stored, failed: p.failed };
    });
  }

  // Fetch and store CIP-100/CIP-136 vote rationale anchors for votes that have
  // a metadata_url but no rationale stored yet. Paced with the same interval as
  // the votes phase to avoid hammering anchor hosts. Not the primary phase.
  await phase('rationales', async () => {
    const r = await syncVoteRationales({ db: env.DB, now: Date.now(), paceMs: VOTE_PACE_MS });
    console.log(`[vote-rationales] fetched=${r.fetched} ok=${r.ok} empty=${r.empty} failed=${r.failed}`);
    return { items: r.ok, failed: r.failed };
  });

  // One-time historical fill for finalised actions never vote-synced. Small,
  // paced budget so the hourly run stays light; drains over many hours.
  await phase('finalized-backfill', async () => {
    const bf = await backfillFinalizedVotes({ koios, db: env.DB, now, limit: 6, paceMs: VOTE_PACE_MS });
    console.log(`[gov-votes-backfill] actions=${bf.actions} votes=${bf.votes} failed=${bf.failed}`);
    return { items: bf.votes, failed: bf.failed };
  });

  // Recompute the committee yes-percentage to the ledger-exact value once an
  // action's votes are synced, replacing Koios' committee_yes_pct (which miscounts
  // rotated hot keys and resigned members). Only-changed and idempotent, so it
  // converges as the finalized-vote backfill drains.
  await phase('committee-pct', async () => {
    const tip = await koios.tip();
    const r = await recomputeCommitteePct(env.DB, tip.epoch_no, 100);
    if (r.updated > 0 || r.skipped > 0) console.log(`[committee-pct] scanned=${r.scanned} updated=${r.updated} skipped=${r.skipped}`);
    return { items: r.updated };
  });

  // One-time historical fill: votes synced before meta_hash capture have no hash,
  // so the rationale queue skips them. Re-fetch a few finalized actions per run to
  // fill the hash; self-draining, becomes a no-op once every action is filled.
  await phase('meta-hash-backfill', async () => {
    const bf = await backfillVoteMetaHashes({ koios, db: env.DB, now, limit: 6, paceMs: VOTE_PACE_MS });
    console.log(`[gov-rationale-hash-backfill] actions=${bf.actions} votes=${bf.votes} failed=${bf.failed}`);
    return { items: bf.votes, failed: bf.failed };
  });

  // One-time historical fill: rationales ingested before the FTS migration have
  // an empty body_text. Strip their stored body_html into body_text so they enter
  // the rationale search index. Self-draining, becomes a no-op once all are filled.
  await phase('rationale-text-backfill', async () => {
    const bf = await backfillRationaleText(env.DB, 200);
    console.log(`[rationale-text-backfill] filled=${bf.filled}`);
    return { items: bf.filled, failed: 0 };
  });

  // Flag optimistic votes that never appeared on chain. Runs after the
  // authoritative sync so any vote that DID land has already cleared its pending
  // marker; only stragglers (tx dropped/rolled back) are flagged here.
  await phase('reconcile-pending', async () => {
    const changed = await reconcilePendingVotes(env.DB, Math.floor(Date.now() / 1000));
    if (changed > 0) console.log(`[gov-votes-reconcile] failed=${changed}`);
    return { items: changed };
  });

  // Remove multisig pending votes whose collection window has elapsed. Runs
  // alongside reconcile-pending; a cleanup failure must not abort the sync.
  await phase('expire-multisig', async () => {
    const deleted = await deleteExpiredPending(env.DB, Math.floor(Date.now() / 1000));
    if (deleted > 0) console.log(`[multisig-expire] deleted=${deleted}`);
    return { items: deleted };
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
      // Inline base64 avatars are decoded and stored in R2 during the sync (they
      // are self-contained); linked images are handled by the avatars phase below.
      bucket: env.AVATARS,
      downscale: env.IMAGES ? imagesDownscaler(env.IMAGES) : undefined,
    });
    console.log(
      `[drep-sync] total=${r.total} updated=${r.updated} skipped=${r.skipped} ` +
        `deactivated=${r.deactivated} anchorsFetched=${r.anchorsFetched} ` +
        `anchorsDeferred=${r.anchorsDeferred} failed=${r.failed}`,
    );
    return { items: r.total, failed: r.failed };
  }, { primary: true });

  // Capture per-epoch voting power snapshots for the list delta chip and the
  // profile sparkline. Self-healing: fetches only epochs not yet stored, prunes
  // the rolling window, and projects the latest two snapshots onto the dreps rows.
  // Inserts are chunked to stay under D1's 100 bound-parameter-per-query limit.
  // A fetch failure here must not fail the DRep sync that already succeeded.
  await phase('voting-power-history', async () => {
    const tip = await koios.tip();
    const r = await syncDrepVotingPowerHistory({ koios, db: env.DB, currentEpoch: tip.epoch_no });
    console.log(
      `[drep-vp-history] window=${r.window[0]}..${r.window[r.window.length - 1]} ` +
        `fetched=${r.fetchedEpochs.length} inserted=${r.inserted} pruned=${r.pruned}`,
    );
    return { items: r.inserted };
  });

  // Backfill registration epochs for any DReps still missing one (drives the
  // participation stat). No-op once all are filled; only new DReps cost a page.
  await phase('registered-epochs', async () => {
    const cfg = resolveNetwork(env.CARDANO_NETWORK ?? null);
    const reg = await backfillRegisteredEpochs({ koios, db: env.DB, cfg });
    console.log(`[drep-reg-backfill] missing=${reg.missing} resolved=${reg.resolved} pages=${reg.pages}`);
    return { items: reg.resolved };
  });

  // Refresh delegator headcounts for the stalest DReps. Isolated phase: a Koios
  // hiccup here must not fail the DRep sync that already succeeded. Only the two
  // count columns change, so no FTS churn.
  await phase('delegator-counts', async () => {
    const r = await syncDrepDelegatorCounts({
      koios,
      db: env.DB,
      now: Date.now(),
      limit: DREP_DELEGATOR_COUNT_LIMIT,
    });
    console.log(
      `[drep-delegators] scanned=${r.scanned} updated=${r.updated} failed=${r.failed}`,
    );
    return { items: r.updated, failed: r.failed };
  });

  // Mint profile slugs for newly named DReps (pure D1, no Koios). A profile
  // without a slug simply keeps its id URL until the next run.
  await phase('slugs', async () => {
    const slugs = await backfillDrepSlugs(env.DB);
    if (slugs.missing > 0) console.log(`[drep-slugs] missing=${slugs.missing} assigned=${slugs.assigned}`);
    return { items: slugs.assigned };
  });

  // Fetch pool metadata and logo URLs from Koios for active pools. Only-changed
  // writes; pools not yet due for a refresh are skipped. A failure here must not
  // fail the DRep sync that already succeeded (phase isolation).
  await phase('pools', async () => {
    const r = await syncPools({ koios, db: env.DB, fetchImpl: fetch, nowMs: Date.now() });
    console.log(`[pools] scanned=${r.scanned} updated=${r.updated} logos=${r.logos}`);
    return { items: r.updated };
  });

  // Store new/changed avatars in R2 and GC orphaned objects. A failure here
  // must not fail the DRep sync that already succeeded (phase isolation).
  if (env.AVATARS) {
    const bucket = env.AVATARS;
    // Avatar fetches give up on a source after AVATAR_FETCH_MAX_ATTEMPTS failures
    // (see avatarStore), so a permanently broken image stops being retried every
    // run instead of pinning this sync at 'partial' forever.
    await phase('avatars', async () => {
      const a = await storeDrepAvatars({
        db: env.DB,
        bucket,
        fetchImpl: fetch,
        downscale: env.IMAGES ? imagesDownscaler(env.IMAGES) : undefined,
      });
      console.log(`[drep-avatars] scanned=${a.scanned} stored=${a.stored} cleared=${a.cleared} failed=${a.failed}`);
      const p = await storePoolAvatars({
        db: env.DB,
        bucket,
        fetchImpl: fetch,
        downscale: env.IMAGES ? imagesDownscaler(env.IMAGES) : undefined,
      });
      console.log(`[pool-avatars] scanned=${p.scanned} stored=${p.stored} cleared=${p.cleared} failed=${p.failed}`);
      const poolHashes = await listReferencedPoolImageHashes(env.DB);
      const gc = await gcDrepAvatars({ db: env.DB, bucket, nowMs: Date.now(), extraReferenced: poolHashes });
      console.log(`[drep-avatars-gc] scanned=${gc.scanned} deleted=${gc.deleted}`);
      return { items: a.stored + p.stored, failed: a.failed + p.failed };
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
