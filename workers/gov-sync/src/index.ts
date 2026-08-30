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
// This entry only builds the runtime context (bindings, Koios client, gates)
// and dispatches the cron kind to its phase registry in src/lib/sync/phases/;
// the phases themselves are ordinary testable application modules. Every run
// is recorded in the sync_runs table via recordSyncRun: each phase fails in
// isolation (a Koios hiccup in one phase no longer skips the rest), and the
// run row carries ok/partial/error plus per-phase outcomes for /debug/sync.
//
// Deployed separately from the app via Cloudflare Workers Builds. The build
// trigger watches the whole repository (watch path `*`), so changes to the
// shared src/lib code this worker bundles redeploy it automatically on merge.

import { resolveNetwork } from '../../../src/lib/config/network.js';
import { createKoiosClient } from '../../../src/lib/koios/client.js';
import { resolveCronKind } from '../../../src/lib/freshness.js';
import { recordSyncRun, type PhaseFn } from '../../../src/lib/sync/runRecorder.js';
import { runPhases } from '../../../src/lib/sync/phases/registry.js';
import type { CoreSyncContext } from '../../../src/lib/sync/phases/context.js';
import { governancePhases } from '../../../src/lib/sync/phases/governance.js';
import { votePhases } from '../../../src/lib/sync/phases/votes.js';
import { drepPhases, initialDrepSyncState } from '../../../src/lib/sync/phases/dreps.js';
import { imagesDownscaler } from '../../../src/lib/dreps/avatarStore.js';
import type { VapidConfig } from '../../../src/lib/push/webPush.js';

// The binding shapes live once on the global Cloudflare.Env augmentation
// (src/env.d.ts, same TS program); this worker only narrows DB to required
// since every phase needs the database.
interface Env extends Cloudflare.Env {
  DB: D1Database;
}

/** R2 bucket for mirrored avatars/logos; a missing binding skips those phases (warned once per run). */
function avatarsBinding(env: Env): R2Bucket | null {
  if (!env.AVATARS) {
    console.warn('[gov-sync] AVATARS binding missing; avatar phases skipped');
    return null;
  }
  return env.AVATARS;
}

/** Both VAPID keys must be set (the private key is a secret) or push dispatch fails soft. */
function buildVapid(env: Env, siteOrigin: string): VapidConfig | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: siteOrigin };
}

/** The context core every registry shares: bindings resolved, Koios client built. */
function buildCore(env: Env): CoreSyncContext {
  const cfg = resolveNetwork(env.CARDANO_NETWORK ?? null);
  // proposal_voting_summary / proposal_votes are heavy aggregations that can take
  // 10-25s when Koios is under load. The default 10s timeout drops them and the
  // action never syncs, so wait longer here and retry transient failures with
  // exponential backoff (500ms then 1s, plus any server-sent Retry-After). The
  // per-run limits in the phase registries bound the worst-case wall time.
  const koios = createKoiosClient({
    baseUrl: cfg.koiosBaseUrl,
    token: env.KOIOS_API_KEY || undefined,
    timeoutMs: 25_000,
    retries: 2,
    retryDelayMs: 500,
  });
  return { db: env.DB, koios, cfg, now: Date.now() };
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
      // The governance trigger fires every 5 min; its heavy tally/backfill
      // phases run only on the quarter-hours (minute % 15 === 0), so those keep
      // the old 15-min cost while discovery + notification dispatch run every
      // 5 min. The vote trigger fires every 20 min; the badges phase inside it
      // is the biggest D1 consumer, so it runs only on the top of the hour.
      const minute = new Date(event.scheduledTime).getUTCMinutes();
      const core = buildCore(env);
      // Built once per run; the Images binding is optional everywhere it is used.
      const downscale = env.IMAGES ? imagesDownscaler(env.IMAGES) : undefined;
      const run = (phase: PhaseFn): Promise<void> => {
        switch (kind) {
          case 'dreps': {
            const ctx = {
              ...core,
              avatars: avatarsBinding(env),
              downscale,
              state: initialDrepSyncState(),
            };
            return runPhases(drepPhases, ctx, phase);
          }
          case 'votes': {
            const ctx = {
              ...core,
              hourly: minute === 0,
              avatars: avatarsBinding(env),
              downscale,
            };
            return runPhases(votePhases, ctx, phase);
          }
          default: {
            const ctx = {
              ...core,
              heavy: minute % 15 === 0,
              vapid: buildVapid(env, core.cfg.siteOrigin),
              telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? null,
            };
            return runPhases(governancePhases, ctx, phase);
          }
        }
      };
      const summary = await recordSyncRun(env.DB, kind, run);
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
