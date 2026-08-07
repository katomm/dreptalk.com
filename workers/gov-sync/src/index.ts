/// <reference types="@cloudflare/workers-types" />
// Standalone cron worker: three triggers share this handler, dispatched on
// event.cron against the constants in src/lib/freshness.js (kept in sync with
// wrangler.toml's `crons`).
//   */5 * * * *   discover governance actions + dispatch pending notifications;
//                 the heavy active-action tallies + backfills only run on the
//                 quarter-hours (scheduled minute % 15 === 0).
//   */20 * * * *  refresh the larger per-post vote lists (active actions only).
//   0 */6 * * *   enumerate every registered DRep and persist profile data.
// Shares the app's D1 database.
//
// Every run is recorded in the sync_runs table via recordSyncRun: each pass is
// a phase that fails in isolation (a Koios hiccup in one pass no longer skips
// the rest), and the run row carries ok/partial/error plus per-phase outcomes
// for the /debug/sync page.
//
// Deployed separately from the app via Cloudflare Workers Builds. The build
// trigger watches the whole repository (watch path `*`), so changes to the
// shared src/lib code this worker bundles redeploy it automatically on merge.

import { resolveNetwork } from '../../../src/lib/config/network.js';
import { createKoiosClient } from '../../../src/lib/koios/client.js';
import { activeCommitteeSize } from '../../../src/lib/koios/committee.js';
import { bytesToHex } from '../../../src/lib/crypto/hex.js';
import { resolveCronKind } from '../../../src/lib/freshness.js';
import {
  syncGovernanceActions,
  backfillActionMetadata,
  backfillGovTopicSubmittedAt,
  backfillGovTopicTitles,
  refreshTrendingScores,
} from '../../../src/lib/governance/sync.js';
import { syncGovernanceTallies, syncGovernanceVotes, backfillVotedPower, backfillThresholdSnapshots, backfillFinalizedVotes, backfillVoteMetaHashes, backfillGovStatusTimes, reconcilePendingVotes } from '../../../src/lib/governance/tallySync.js';
import { syncVoteRationales } from '../../../src/lib/governance/rationaleSync.js';
import { syncCommitteeVoteMeta } from '../../../src/lib/governance/committeeMetaSync.js';
import { backfillVoteHistorySweep } from '../../../src/lib/governance/voteHistoryBackfill.js';
import { backfillRationaleText } from '../../../src/lib/db/rationaleTextBackfill.js';
import { syncDreps, backfillRegisteredEpochs, backfillDrepSlugs } from '../../../src/lib/dreps/sync.js';
import { getFollowedDrepIds } from '../../../src/lib/db/delegatorFollows.js';
import { runFanout } from '../../../src/lib/notifications/fanout.js';
import { syncDrepVotingPowerHistory } from '../../../src/lib/dreps/votingPowerHistorySync.js';
import { runDrepStatsDigest } from '../../../src/lib/db/drepStatsDigest.js';
import { awardBadges } from '../../../src/lib/badges/engine.js';
import { storeDrepAvatars, gcDrepAvatars, imagesDownscaler } from '../../../src/lib/dreps/avatarStore.js';
import { syncPools } from '../../../src/lib/pools/sync.js';
import { storePoolAvatars } from '../../../src/lib/pools/avatarStore.js';
import { listReferencedPoolImageHashes, backfillPoolSlugs } from '../../../src/lib/db/pools.js';
import { upsertProtocolParams, getProtocolParams } from '../../../src/lib/db/protocolParams.js';
import { syncCurrentCommitteeMembership, recomputeCommitteePct } from '../../../src/lib/db/committee.js';
import { deleteExpiredPending } from '../../../src/lib/db/pendingMultisigTx.js';
import { recordSyncRun, type PhaseFn } from '../../../src/lib/sync/runRecorder.js';
import { refreshBulk } from '../../../src/lib/delegation/refresh.js';
import { dispatchWebPush, dispatchTelegram } from '../../../src/lib/notifications/dispatch.js';
import { sendWebPush, type VapidConfig } from '../../../src/lib/push/webPush.js';
import { sendTelegramMessage } from '../../../src/lib/push/telegram.js';

// The binding shapes live once on the global Cloudflare.Env augmentation
// (src/env.d.ts, same TS program); this worker only narrows DB to required
// since every phase needs the database.
interface Env extends Cloudflare.Env {
  DB: D1Database;
}

/** Both VAPID keys must be set (the private key is a secret) or push dispatch fails soft. */
function buildVapid(env: Env): VapidConfig | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  const { siteOrigin } = resolveNetwork(env.CARDANO_NETWORK ?? null);
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: siteOrigin };
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

// Discover new actions, then refresh tallies + lifecycle for active actions.
// This trigger fires every 5 minutes. The cheap, latency-sensitive phases
// (discovery + fan-out + push/telegram dispatch) run every time; the heavy
// tally/backfill/params phases only run when `heavy` is set (the scheduled
// minute is a multiple of 15), so those keep their old 15-minute cost while
// new actions and pending notifications go out within 5 minutes.
async function runGovernanceSync(env: Env, phase: PhaseFn, opts: { heavy: boolean }): Promise<void> {
  const { koios, network } = buildKoios(env);
  const now = Date.now();

  await phase('discovery', async () => {
    const disc = await syncGovernanceActions({ koios, db: env.DB, network, now, rand: randSuffix });
    console.log(`[gov-sync] total=${disc.total} created=${disc.created} skipped=${disc.skipped} failed=${disc.failed}`);
    return { items: disc.total, failed: disc.failed };
  }, { primary: true });

  if (opts.heavy) {
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

  await phase('threshold-backfill', async () => {
    const bf = await backfillThresholdSnapshots({ koios, db: env.DB, limit: 15, paceMs: 100 });
    console.log(`[gov-threshold-backfill] actions=${bf.actions} failed=${bf.failed}`);
    return { items: bf.actions, failed: bf.failed };
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
  } // end heavy-only phases

  // Drain the delegator-notification outbox into per-recipient notification rows.
  // Runs right before the webpush/telegram dispatch phases so a fan-out job
  // materialized earlier in this same run (or by the vote/drep sync crons since
  // the last run) delivers in this run instead of waiting for the next one.
  await phase('delegation-fanout', async () => {
    const r = await runFanout(env.DB, Math.floor(Date.now() / 1000));
    console.log(`[delegation-fanout] jobs=${r.jobs} delivered=${r.delivered} completed=${r.completed}`);
    return { items: r.delivered };
  });

  // After the sync phases: bundle each connected webpush channel's pending replies,
  // mentions, and governance updates into one push. Runs after every other sync
  // phase in this trigger so a governance thread discovered earlier in this same
  // run is already counted.
  // Fails soft (all-zero, one warning) when the VAPID secret pair is not yet set.
  await phase('webpush', async () => {
    const vapid = buildVapid(env);
    const r = await dispatchWebPush(env.DB, vapid, { send: sendWebPush, now: Date.now() });
    console.log(`[webpush-dispatch] sent=${r.sent} pruned=${r.pruned} skipped=${r.skipped}`);
    return { items: r.sent };
  });

  // Same bundles as the webpush phase, delivered as Telegram bot messages.
  // Fails soft (all-zero, one warning) until the bot token secret is set.
  await phase('telegram', async () => {
    const { siteOrigin } = resolveNetwork(env.CARDANO_NETWORK ?? null);
    const cfg = env.TELEGRAM_BOT_TOKEN ? { botToken: env.TELEGRAM_BOT_TOKEN, origin: siteOrigin } : null;
    const r = await dispatchTelegram(env.DB, cfg, { send: sendTelegramMessage, now: Date.now() });
    console.log(`[telegram-dispatch] sent=${r.sent} pruned=${r.pruned} skipped=${r.skipped}`);
    return { items: r.sent };
  });

  // Re-resolve delegator follows whose last Koios check is a day or more stale
  // (or never attempted). gov-sync works in unix milliseconds throughout this
  // file; delegator_follows timestamps are unix seconds (like users.last_verified_at),
  // so convert once here. The due window inside refreshBulk caps this to at most
  // one Koios attempt per address per day. Heavy-only (every 15 min): a day-capped
  // refresh gains nothing from the 5-minute cadence and it is a Koios call.
  if (opts.heavy) {
    await phase('delegation-refresh', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const res = await refreshBulk(env.DB, koios, nowSec);
      console.log(`[delegation-refresh] attempted=${res.attempted} resolved=${res.resolved} changed=${res.changed} failed=${res.failed}`);
      return { items: res.resolved, failed: res.failed };
    });
  }
}

// Refresh the per-post vote lists (active actions only). Every 20 min: vote lists
// are larger than the tally summary, but the budget covers the whole active set
// in one run, so each active action's vote list refreshes every run. Per-action vote
// pagination is bounded (see MAX_VOTE_PAGES in tallySync) so one action with a
// pathologically long vote list cannot run this invocation out of CPU and leave
// the run stuck mid-loop.
async function runVoteSync(env: Env, phase: PhaseFn, opts: { hourly: boolean }): Promise<void> {
  const { koios } = buildKoios(env);
  const now = Date.now();

  await phase('votes', async () => {
    // Loaded once per run and threaded ONLY into the live sync below: a
    // qualifying followed-DRep vote gets a delegator fan-out job atomically with
    // its upsert. The finalized-backfill phase further down deliberately does
    // NOT receive this set, since it re-writes historical votes.
    const followedDrepIds = await getFollowedDrepIds(env.DB);
    const r = await syncGovernanceVotes({ koios, db: env.DB, now, limit: VOTE_LIMIT, paceMs: VOTE_PACE_MS, followedDrepIds });
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

  // Constitutional-committee votes are excluded from the DRep rationale queue
  // (role='DRep', power-gated), so fetch their anchors here: stores the CC
  // rationale and the member's self-declared name from one fetch. Tiny set.
  await phase('committee-meta', async () => {
    const r = await syncCommitteeVoteMeta({ db: env.DB, now: Date.now(), paceMs: VOTE_PACE_MS });
    if (r.fetched > 0) console.log(`[committee-meta] fetched=${r.fetched} ok=${r.ok} named=${r.named} failed=${r.failed}`);
    return { items: r.named, failed: r.failed };
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

  // One-time historical fill: votes synced before meta_hash capture have no
  // hash, so the rationale queue skips them. Hashes are resolved per vote via
  // /vote_list (see backfillVoteMetaHashes for why not /proposal_votes);
  // self-draining, becomes a no-op once every vote is filled.
  await phase('meta-hash-backfill', async () => {
    const bf = await backfillVoteMetaHashes({ koios, db: env.DB, limit: 25, paceMs: VOTE_PACE_MS });
    console.log(`[gov-rationale-hash-backfill] votes=${bf.votes} failed=${bf.failed}`);
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
  // Hourly-gated: the pass makes several full-scan aggregates over drep_votes and
  // is the biggest D1 consumer on this worker; badges are cumulative, so a fresh
  // award taking up to an hour to appear is fine and cuts the frequency 3x on the
  // 20-minute vote cron.
  if (opts.hourly) {
    await phase('badges', async () => {
      const cfg = resolveNetwork(env.CARDANO_NETWORK ?? null);
      const badges = await awardBadges({ db: env.DB, cfg, now: Date.now() });
      console.log(`[badges] desired=${badges.desired} written=${badges.written}`);
      return { items: badges.written };
    });
  }
}

async function runDrepSync(env: Env, phase: PhaseFn): Promise<void> {
  const { koios } = buildKoios(env);

  // Delegator counts Koios actually delivered in this run's dreps phase, for
  // the epoch stamp below. Stays empty when the dreps phase failed, which
  // leaves the epoch's counts NULL until a later pass observes them.
  let observedDelegatorCounts: ReadonlyMap<string, number> = new Map();

  await phase('dreps', async () => {
    // Loaded once per run and threaded into the writers below: an active/inactive
    // flip for a followed DRep gets a delegator status-change fan-out job atomic
    // with its status write.
    const followedDrepIds = await getFollowedDrepIds(env.DB);
    const r = await syncDreps({
      koios, db: env.DB, fetchImpl: fetch, now: Date.now(), maxAnchorFetches: DREP_ANCHOR_LIMIT,
      // Inline base64 avatars are decoded and stored in R2 during the sync (they
      // are self-contained); linked images are handled by the avatars phase below.
      bucket: env.AVATARS,
      downscale: env.IMAGES ? imagesDownscaler(env.IMAGES) : undefined,
      followedDrepIds,
    });
    observedDelegatorCounts = r.observedDelegatorCounts;
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
  // The epoch the history phase captured this run, so the digest below only
  // ever evaluates data written in the same pass. Set only after the history
  // sync returned, so a failed fetch skips the digest until the next run.
  let vpHistoryEpoch: number | null = null;
  await phase('voting-power-history', async () => {
    const tip = await koios.tip();
    const r = await syncDrepVotingPowerHistory({
      koios,
      db: env.DB,
      currentEpoch: tip.epoch_no,
      observedDelegatorCounts,
    });
    vpHistoryEpoch = tip.epoch_no;
    console.log(
      `[drep-vp-history] window=${r.window[0]}..${r.window[r.window.length - 1]} ` +
        `fetched=${r.fetchedEpochs.length} inserted=${r.inserted} pruned=${r.pruned} stamped=${r.stamped}`,
    );
    return { items: r.inserted };
  });

  // Epoch digest for DRep account holders: one notification when voting power
  // or delegator count moved beyond the thresholds. Idempotent per epoch via
  // the notifications event_key index, so running every pass is safe and the
  // 5-minute dispatcher picks the rows up on its next sweep. No second
  // koios.tip(): the epoch rides over from the history phase.
  await phase('drep-stats-digest', async () => {
    if (vpHistoryEpoch === null) return { items: 0 };
    const r = await runDrepStatsDigest(env.DB, vpHistoryEpoch, Date.now());
    console.log(`[drep-stats] epoch=${vpHistoryEpoch} candidates=${r.candidates} fired=${r.fired}`);
    return { items: r.fired };
  });

  // Sweep historical re-votes into drep_vote_history (drives the vote-change
  // stat and the "changed from X" chips for changes that predate live
  // tracking). A few actions drain per run; no-op once every action is swept.
  await phase('vote-history-sweep', async () => {
    const sweep = await backfillVoteHistorySweep({ koios, db: env.DB, now: Date.now() });
    if (sweep.pending > 0) {
      console.log(
        `[vote-history-sweep] pending=${sweep.pending} swept=${sweep.swept} inserted=${sweep.inserted} failed=${sweep.failed}`,
      );
    }
    return { items: sweep.inserted };
  });

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

  // Mint profile slugs for newly named pools (pure D1, no Koios). Mirrors the
  // DRep slugs phase above; a pool without a slug simply keeps its id URL.
  await phase('pool-slugs', async () => {
    const slugs = await backfillPoolSlugs(env.DB);
    if (slugs.missing > 0) console.log(`[pool-slugs] missing=${slugs.missing} assigned=${slugs.assigned}`);
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
      // Strict dispatch: an unknown cron runs nothing. Falling back to the
      // governance sync here would let a toml/constant typo silently run the
      // wrong sync on that schedule with no error.
      const kind = resolveCronKind(event.cron);
      if (!kind) {
        console.error(
          `[gov-sync] unknown cron "${event.cron}": no sync dispatched. Align wrangler.toml crons with the CRON_* constants in src/lib/freshness.ts.`,
        );
        return;
      }
      // The governance trigger fires every 5 min; run its heavy tally/backfill
      // phases only on the quarter-hours (minute % 15 === 0), so those keep the
      // old 15-min cost while discovery + notification dispatch run every 5 min.
      // The vote trigger fires every 20 min; the badges pass inside it is the
      // biggest D1 consumer, so it runs only on the top of the hour (minute 0).
      const minute = new Date(event.scheduledTime).getUTCMinutes();
      const heavy = minute % 15 === 0;
      const hourly = minute === 0;
      const run =
        kind === 'dreps'
          ? (env: Env, phase: PhaseFn) => runDrepSync(env, phase)
          : kind === 'votes'
            ? (env: Env, phase: PhaseFn) => runVoteSync(env, phase, { hourly })
            : (env: Env, phase: PhaseFn) => runGovernanceSync(env, phase, { heavy });
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
