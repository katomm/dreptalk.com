/// <reference types="@cloudflare/workers-types" />
// Phase registry for the notifications cron (2-59/5): drain the delegator
// fan-out outbox, write the delegation digest, then deliver bundled web push and
// Telegram messages. Runs in its own invocation, two minutes after each
// governance tick, so these phases share the per-invocation D1 query limit only
// with each other. Every query goes through the counting wrapper, and each
// phase gets an allowance.

import { runDelegationDigest } from '../../db/delegationDigest.js';
import { runFanout } from '../../notifications/fanout.js';
import { dispatchWebPush, dispatchTelegram } from '../../notifications/dispatch.js';
import type { sendWebPush, VapidConfig } from '../../push/webPush.js';
import type { sendTelegramMessage } from '../../push/telegram.js';
import { allowance, type QueryMeter } from '../queryBudget.js';
import type { CoreSyncContext } from './context.js';
import type { SyncPhaseDef } from './registry.js';

/** Below the documented 1000 D1 queries per invocation, leaving room for the run recorder. */
export const NOTIFICATIONS_QUERY_BUDGET = 900;
/** The fan-out's cap. Web push then gets half of what is left, Telegram the rest. */
export const FANOUT_QUERY_SHARE = 300;
/**
 * The delegation digest's cap. A normal pass needs at most four queries, only
 * the one build pass per epoch needs more (about 100 for 1,100 followed DReps).
 */
export const DIGEST_QUERY_SHARE = 400;
/** Followers who get their epoch digest per pass, written by one statement. */
export const DIGEST_RECIPIENTS_PER_RUN = 500;

export interface NotificationsSyncContext extends CoreSyncContext {
  /** Counts every query issued through ctx.db. */
  meter: QueryMeter;
  /** The transports, injected so the registry can run in tests with fakes. */
  senders: { webpush: typeof sendWebPush; telegram: typeof sendTelegramMessage };
  /** Null until both VAPID keys are configured; the webpush phase fails soft. */
  vapid: VapidConfig | null;
  /** Null until the bot token secret is set; the telegram phase fails soft. */
  telegramBotToken: string | null;
}

const left = (ctx: NotificationsSyncContext) => Math.max(0, NOTIFICATIONS_QUERY_BUDGET - ctx.meter.used());

export const notificationPhases: readonly SyncPhaseDef<NotificationsSyncContext>[] = [
  {
    // Before the dispatch phases, so rows materialized here go out in this run.
    name: 'delegation-fanout',
    run: async (ctx) => {
      const r = await runFanout(ctx.db, Math.floor(Date.now() / 1000), {
        allowance: allowance(ctx.meter, Math.min(FANOUT_QUERY_SHARE, left(ctx))),
      });
      console.log(`[delegation-fanout] jobs=${r.jobs} delivered=${r.delivered} completed=${r.completed} deferred=${r.deferred}`);
      return { items: r.delivered };
    },
  },
  {
    // After the fan-out and before the dispatchers, so digests written here go
    // out in this run. Builds the completed epoch's per-DRep summary once, then
    // writes a capped page of digests per pass until every follower has one.
    name: 'delegation-digest',
    run: async (ctx) => {
      const r = await runDelegationDigest(ctx.db, ctx.cfg, Math.floor(Date.now() / 1000), {
        budget: allowance(ctx.meter, Math.min(DIGEST_QUERY_SHARE, left(ctx))),
        recipients: DIGEST_RECIPIENTS_PER_RUN,
      });
      console.log(`[delegation-digest] epoch=${r.epoch} state=${r.state} inserted=${r.inserted}`);
      return { items: r.inserted };
    },
  },
  {
    // Fails soft (all-zero, one warning) when the VAPID secret pair is not yet set.
    name: 'webpush',
    run: async (ctx) => {
      const r = await dispatchWebPush(ctx.db, ctx.vapid, {
        send: ctx.senders.webpush,
        allowance: allowance(ctx.meter, Math.floor(left(ctx) / 2)),
      });
      console.log(`[webpush-dispatch] sent=${r.sent} pruned=${r.pruned} skipped=${r.skipped} deferred=${r.deferred}`);
      return { items: r.sent };
    },
  },
  {
    // Same bundles as the webpush phase, as Telegram bot messages. Gets whatever
    // the earlier phases left. Fails soft until the bot token secret is set.
    name: 'telegram',
    run: async (ctx) => {
      const cfg = ctx.telegramBotToken ? { botToken: ctx.telegramBotToken, origin: ctx.cfg.siteOrigin } : null;
      const r = await dispatchTelegram(ctx.db, cfg, {
        send: ctx.senders.telegram,
        allowance: allowance(ctx.meter, left(ctx)),
      });
      console.log(`[telegram-dispatch] sent=${r.sent} pruned=${r.pruned} skipped=${r.skipped} deferred=${r.deferred}`);
      return { items: r.sent };
    },
  },
];
