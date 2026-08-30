// Phase registry for the governance cron (*/5): discover governance actions and
// dispatch pending notifications every tick; the heavy tally/backfill/params
// phases run only when `heavy` is set (the scheduled minute is a multiple of
// 15), so those keep their old 15-minute cost while new actions and pending
// notifications go out within 5 minutes.

import { bytesToHex } from '../../crypto/hex.js';
import {
  syncGovernanceActions,
  backfillActionMetadata,
  backfillGovTopicSubmittedAt,
  backfillGovTopicTitles,
  refreshTrendingScores,
} from '../../governance/sync.js';
import {
  syncGovernanceTallies,
  backfillVotedPower,
  backfillThresholdSnapshots,
  backfillGovStatusTimes,
} from '../../governance/tallySync.js';
import { syncProtocolParams } from '../../governance/paramsSync.js';
import { runCip100Sync } from '../../cip100/cron.js';
import { originForNetwork } from '../../cip100/origin.js';
import { runPostErasureSweep } from '../../db/postErasure.js';
import { runFanout } from '../../notifications/fanout.js';
import { dispatchWebPush, dispatchTelegram } from '../../notifications/dispatch.js';
import { sendWebPush, type VapidConfig } from '../../push/webPush.js';
import { sendTelegramMessage } from '../../push/telegram.js';
import { refreshBulk } from '../../delegation/refresh.js';
import type { CoreSyncContext } from './context.js';
import type { SyncPhaseDef } from './registry.js';

export interface GovernanceSyncContext extends CoreSyncContext {
  /** Heavy tick (scheduled minute % 15 === 0): tally/backfill/params phases run. */
  heavy: boolean;
  /** Null until both VAPID keys are configured; the webpush phase fails soft. */
  vapid: VapidConfig | null;
  /** Null until the bot token secret is set; the telegram phase fails soft. */
  telegramBotToken: string | null;
}

// Per-run tally budget: each run tallies at most this many (stale-first), paced
// apart, and the backlog drains over a few runs. Kept small so that even when
// every Koios call runs to the 25s timeout the run stays well within cron limits.
const TALLY_LIMIT = 12;
const TALLY_PACE_MS = 200;

/** Short random hex for topic slug suffixes. */
function randSuffix(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(4)));
}

const heavyOnly = (ctx: GovernanceSyncContext) => ctx.heavy;

export const governancePhases: readonly SyncPhaseDef<GovernanceSyncContext>[] = [
  {
    name: 'discovery',
    primary: true,
    run: async (ctx) => {
      const disc = await syncGovernanceActions({
        koios: ctx.koios, db: ctx.db, network: ctx.cfg.network, now: ctx.now, rand: randSuffix,
      });
      console.log(`[gov-sync] total=${disc.total} created=${disc.created} skipped=${disc.skipped} failed=${disc.failed}`);
      return { items: disc.total, failed: disc.failed };
    },
  },
  {
    // The tip lookup lives inside the tally phase: tallies are its only consumer,
    // so a tip failure surfaces as a failed tallies phase, not a failed discovery.
    name: 'tallies',
    when: heavyOnly,
    run: async (ctx) => {
      const tip = await ctx.koios.tip();
      const tally = await syncGovernanceTallies({
        koios: ctx.koios,
        db: ctx.db,
        currentEpoch: tip.epoch_no,
        now: ctx.now,
        network: ctx.cfg.network,
        limit: TALLY_LIMIT,
        paceMs: TALLY_PACE_MS,
      });
      console.log(`[gov-tally] active=${tally.active} updated=${tally.updated} frozen=${tally.frozen} reSynced=${tally.reSynced} failed=${tally.failed}`);
      return { items: tally.updated + tally.reSynced, failed: tally.failed };
    },
  },
  {
    // Re-date gov_status feed events to their on-chain epoch boundary when the stored
    // time drifted (e.g. a backlog of terminal transitions caught up in one run, which
    // would otherwise all read "just now"). Pure D1, only-changed; a no-op once settled.
    name: 'gov-status-times',
    when: heavyOnly,
    run: async (ctx) => {
      const fixed = await backfillGovStatusTimes({ db: ctx.db, network: ctx.cfg.network, limit: 500 });
      console.log(`[gov-status-times] scanned=${fixed.scanned} updated=${fixed.updated}`);
      return { items: fixed.updated };
    },
  },
  {
    name: 'voted-power',
    when: heavyOnly,
    run: async (ctx) => {
      const backfill = await backfillVotedPower({ koios: ctx.koios, db: ctx.db, limit: 25 });
      console.log(`[gov-backfill] scanned=${backfill.scanned} updated=${backfill.updated} failed=${backfill.failed}`);
      return { items: backfill.updated, failed: backfill.failed };
    },
  },
  {
    name: 'threshold-backfill',
    when: heavyOnly,
    run: async (ctx) => {
      const bf = await backfillThresholdSnapshots({ koios: ctx.koios, db: ctx.db, limit: 15, paceMs: 100 });
      console.log(`[gov-threshold-backfill] actions=${bf.actions} failed=${bf.failed}`);
      return { items: bf.actions, failed: bf.failed };
    },
  },
  {
    name: 'metadata',
    when: heavyOnly,
    run: async (ctx) => {
      const metaBackfill = await backfillActionMetadata({ db: ctx.db, now: Date.now(), fetchImpl: fetch, limit: 10 });
      console.log(`[gov-meta-backfill] scanned=${metaBackfill.scanned} updated=${metaBackfill.updated} failed=${metaBackfill.failed}`);
      return { items: metaBackfill.updated, failed: metaBackfill.failed };
    },
  },
  {
    // Reconcile topic titles + opening posts with the (now-present) action title. Runs
    // after the metadata phase so a title recovered this run is propagated to its topic in
    // the same run. Pure D1, only-changed; a settled run writes nothing.
    name: 'gov-titles',
    when: heavyOnly,
    run: async (ctx) => {
      const titles = await backfillGovTopicTitles({ db: ctx.db, network: ctx.cfg.network, limit: 200 });
      console.log(`[gov-title-backfill] scanned=${titles.scanned} updated=${titles.updated}`);
      return { items: titles.updated };
    },
  },
  {
    // Correct post dates for existing no-reply governance topics (sync-time -> submission
    // time). Idempotent: a no-op once corrected. The whole backlog is low hundreds, so
    // one generous limit drains it in a single run.
    name: 'post-dates',
    when: heavyOnly,
    run: async (ctx) => {
      const postDate = await backfillGovTopicSubmittedAt({ db: ctx.db, network: ctx.cfg.network, limit: 500 });
      console.log(`[gov-postdate-backfill] scanned=${postDate.scanned} updated=${postDate.updated}`);
      return { items: postDate.updated };
    },
  },
  {
    // Recompute the materialized trending sort key so the list page can order and
    // page in the database. Runs after discovery, tallies, and the post-date backfill so
    // it folds in everything this run changed. Only-changed writes; a no-op once settled.
    name: 'trending',
    when: heavyOnly,
    run: async (ctx) => {
      const trending = await refreshTrendingScores({ db: ctx.db });
      console.log(`[gov-trending] scanned=${trending.scanned} updated=${trending.updated}`);
      return { items: trending.updated };
    },
  },
  {
    // Refresh the cached CIP-1694 voting thresholds + committee quorum. Changes
    // only via governance, so this is a cheap once-per-run call with an
    // only-changed write (see governance/paramsSync.ts for the details).
    name: 'params',
    when: heavyOnly,
    run: async (ctx) => {
      const r = await syncProtocolParams({ koios: ctx.koios, db: ctx.db, now: ctx.now });
      return { items: r.written };
    },
  },
  {
    // Drain the delegator-notification outbox into per-recipient notification rows.
    // Runs right before the webpush/telegram dispatch phases so a fan-out job
    // materialized earlier in this same run (or by the vote/drep sync crons since
    // the last run) delivers in this run instead of waiting for the next one.
    name: 'delegation-fanout',
    run: async (ctx) => {
      const r = await runFanout(ctx.db, Math.floor(Date.now() / 1000));
      console.log(`[delegation-fanout] jobs=${r.jobs} delivered=${r.delivered} completed=${r.completed}`);
      return { items: r.delivered };
    },
  },
  {
    // After the sync phases: bundle each connected webpush channel's pending replies,
    // mentions, and governance updates into one push. Runs after every other sync
    // phase in this trigger so a governance thread discovered earlier in this same
    // run is already counted.
    // Fails soft (all-zero, one warning) when the VAPID secret pair is not yet set.
    name: 'webpush',
    run: async (ctx) => {
      const r = await dispatchWebPush(ctx.db, ctx.vapid, { send: sendWebPush, now: Date.now() });
      console.log(`[webpush-dispatch] sent=${r.sent} pruned=${r.pruned} skipped=${r.skipped}`);
      return { items: r.sent };
    },
  },
  {
    // Same bundles as the webpush phase, delivered as Telegram bot messages.
    // Fails soft (all-zero, one warning) until the bot token secret is set.
    name: 'telegram',
    run: async (ctx) => {
      const cfg = ctx.telegramBotToken ? { botToken: ctx.telegramBotToken, origin: ctx.cfg.siteOrigin } : null;
      const r = await dispatchTelegram(ctx.db, cfg, { send: sendTelegramMessage, now: Date.now() });
      console.log(`[telegram-dispatch] sent=${r.sent} pruned=${r.pruned} skipped=${r.skipped}`);
      return { items: r.sent };
    },
  },
  {
    // Re-resolve delegator follows whose last Koios check is a day or more stale
    // (or never attempted). gov-sync works in unix milliseconds throughout;
    // delegator_follows timestamps are unix seconds (like users.last_verified_at),
    // so convert once here. The due window inside refreshBulk caps this to at most
    // one Koios attempt per address per day. Heavy-only (every 15 min): a day-capped
    // refresh gains nothing from the 5-minute cadence and it is a Koios call.
    name: 'delegation-refresh',
    when: heavyOnly,
    run: async (ctx) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const res = await refreshBulk(ctx.db, ctx.koios, nowSec);
      console.log(`[delegation-refresh] attempted=${res.attempted} resolved=${res.resolved} changed=${res.changed} failed=${res.failed}`);
      return { items: res.resolved, failed: res.failed };
    },
  },
  {
    // Erasure: a deleted post's text is removed from every store it lives in once
    // its retention window has passed. Runs before the cip100 phase, but the
    // order is not load-bearing: the two phases operate on disjoint row sets.
    name: 'post-erasure',
    run: async (ctx) => {
      const r = await runPostErasureSweep(ctx.db, { now: ctx.now, limit: 200 });
      // Logged only when there is something to say, but `remaining` and `failed`
      // are always part of it: a backlog that is not draining has to be visible
      // rather than reading as a quiet run.
      if (r.stamped > 0 || r.erased > 0 || r.failed > 0 || r.remaining > 0) {
        console.log(
          `[post-erasure] stamped=${r.stamped} erased=${r.erased} failed=${r.failed} remaining=${r.remaining}`,
        );
      }
      return { items: r.erased, failed: r.failed };
    },
  },
  {
    // CIP-100 documents: a bounded reconcile batch. Cheap enough for every tick,
    // and running it often keeps the citable state close to the live state.
    name: 'cip100',
    run: async (ctx) => {
      const r = await runCip100Sync(ctx.db, {
        origin: originForNetwork(ctx.cfg.network),
        network: ctx.cfg.network,
        now: ctx.now,
        limit: 200,
      });
      console.log(`[cip100] reconciled=${r.reconciled} skipped=${r.skipped} failed=${r.failed}`);
      return { items: r.reconciled, failed: r.failed };
    },
  },
];
