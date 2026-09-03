// Phase registry for the DRep cron (0 */6): enumerate every registered DRep and
// persist profile data, then the derived per-epoch and per-profile passes.
// Two values genuinely flow between phases (the delegator counts observed by
// the dreps phase, and the epoch the voting-power history captured); they live
// in an explicitly typed per-run state rather than ad-hoc locals.

import { syncDreps, backfillRegisteredEpochs, backfillDrepSlugs } from '../../dreps/sync.js';
import { syncDrepVotingPowerHistory } from '../../dreps/votingPowerHistorySync.js';
import { runDrepStatsDigest } from '../../db/drepStatsDigest.js';
import { backfillVoteHistorySweep } from '../../governance/voteHistoryBackfill.js';
import { syncCurrentEpochStats, backfillEpochStats } from '../../analytics/epochStatsSync.js';
import { getFollowedDrepIds } from '../../db/delegatorFollows.js';
import {
  listCohortCandidates,
  listQualifyingDecidedEpochs,
  listDrepVoteCounts,
  listDrepRationaleCounts,
  replaceReportCards,
} from '../../db/drepReportCard.js';
import { computeReportCards } from '../../analytics/reportCardView.js';
import {
  storeDrepAvatars,
  gcDrepAvatars,
  type ImageDownscaler,
} from '../../dreps/avatarStore.js';
import { refitStoredAvatars, type RefitTable } from '../../avatars/refit.js';
import {
  listDrepImageHashesNeedingFit,
  markDrepImageFitChecked,
  repointDrepImageHash,
} from '../../db/dreps.js';
import {
  listReferencedPoolImageHashes,
  listPoolImageHashesNeedingFit,
  markPoolImageFitChecked,
  repointPoolImageHash,
  backfillPoolSlugs,
} from '../../db/pools.js';

import type { CoreSyncContext } from './context.js';
import type { SyncPhaseDef } from './registry.js';
import { poolsPhase, mirrorPoolAvatars } from './shared.js';

// Both tables reference objects in the one avatars bucket, so the refit pass
// gets each table's queue and writers here, where both are already in scope.
const REFIT_TABLES: RefitTable[] = [
  {
    listPending: listDrepImageHashesNeedingFit,
    markChecked: markDrepImageFitChecked,
    repoint: repointDrepImageHash,
  },
  {
    listPending: listPoolImageHashesNeedingFit,
    markChecked: markPoolImageFitChecked,
    repoint: repointPoolImageHash,
  },
];

/** Cross-phase state of one DRep run. Keep this small and explicit. */
export interface DrepSyncState {
  /**
   * Delegator counts Koios actually delivered in this run's dreps phase, for
   * the voting-power-history epoch stamp. Stays empty when the dreps phase
   * failed, which leaves the epoch's counts NULL until a later pass observes them.
   */
  observedDelegatorCounts: ReadonlyMap<string, number>;
  /**
   * The epoch the history phase captured this run, so the digest only ever
   * evaluates data written in the same pass. Set only after the history sync
   * returned, so a failed fetch skips the digest until the next run.
   */
  vpHistoryEpoch: number | null;
}

export function initialDrepSyncState(): DrepSyncState {
  return { observedDelegatorCounts: new Map(), vpHistoryEpoch: null };
}

export interface DrepSyncContext extends CoreSyncContext {
  /** R2 bucket for mirrored avatars; the avatar phase is skipped without it. */
  avatars: R2Bucket | null;
  /** Downscaler from the Images binding, undefined when the binding is absent. */
  downscale: ImageDownscaler | undefined;
  state: DrepSyncState;
}

// Per-run anchor-fetch budget for the DRep sync. The first sync from an empty
// database would otherwise fetch every DRep's CIP-119 anchor in one invocation
// and blow the Workers subrequest limit; with the budget, the backlog drains
// over a few 6-hour runs (deferred anchors resume automatically). Steady-state
// runs fetch only changed anchors and never come near the cap.
const DREP_ANCHOR_LIMIT = 400;

// Historical epochs fetched per run. ~150 epochs exist per network at
// introduction. At 36 per run and four 6-hour runs per day the backfill
// drains in about a day, so the homepage sparklines and the share card,
// which draw only the gapless tail of the series, get their trend within
// a day of a fresh deploy. Each epoch costs one totals call plus a few
// history pages, well inside a run's subrequest budget.
const EPOCH_STATS_BACKFILL_PER_RUN = 36;

export const drepPhases: readonly SyncPhaseDef<DrepSyncContext>[] = [
  {
    name: 'dreps',
    primary: true,
    run: async (ctx) => {
      // Loaded once per run and threaded into the writers below: an active/inactive
      // flip for a followed DRep gets a delegator status-change fan-out job atomic
      // with its status write.
      const followedDrepIds = await getFollowedDrepIds(ctx.db);
      const r = await syncDreps({
        koios: ctx.koios, db: ctx.db, fetchImpl: fetch, now: Date.now(), maxAnchorFetches: DREP_ANCHOR_LIMIT,
        // Inline base64 avatars are decoded and stored in R2 during the sync (they
        // are self-contained); linked images are handled by the avatars phase below.
        bucket: ctx.avatars ?? undefined,
        downscale: ctx.downscale,
        followedDrepIds,
      });
      ctx.state.observedDelegatorCounts = r.observedDelegatorCounts;
      console.log(
        `[drep-sync] total=${r.total} updated=${r.updated} skipped=${r.skipped} ` +
          `deactivated=${r.deactivated} anchorsFetched=${r.anchorsFetched} ` +
          `anchorsDeferred=${r.anchorsDeferred} failed=${r.failed}`,
      );
      return { items: r.total, failed: r.failed };
    },
  },
  {
    // Capture per-epoch voting power snapshots for the list delta chip and the
    // profile sparkline. Self-healing: fetches only epochs not yet stored (newest
    // first, budgeted per run), prunes below the retention floor, and projects the
    // latest two snapshots onto the dreps rows. Inserts are chunked to stay under
    // D1's 100 bound-parameter-per-query limit. A fetch failure here must not fail
    // the DRep sync that already succeeded.
    name: 'voting-power-history',
    run: async (ctx) => {
      const tip = await ctx.koios.tip();
      // Full-history retention: the absolute floor is the network's first DRep
      // power epoch (mainnet 508, preprod 164), the same source the epoch-stats
      // backfill uses. A Koios miss falls back to the legacy relative window.
      const floorEpoch = await ctx.koios.firstDrepPowerEpoch().catch(() => null);
      const r = await syncDrepVotingPowerHistory({
        koios: ctx.koios,
        db: ctx.db,
        currentEpoch: tip.epoch_no,
        floorEpoch,
        observedDelegatorCounts: ctx.state.observedDelegatorCounts,
      });
      ctx.state.vpHistoryEpoch = tip.epoch_no;
      console.log(
        `[drep-vp-history] window=${r.window[0]}..${r.window[r.window.length - 1]} ` +
          `fetched=${r.fetchedEpochs.length} inserted=${r.inserted} pruned=${r.pruned} ` +
          `remaining=${r.remaining} stamped=${r.stamped}`,
      );
      return { items: r.inserted };
    },
  },
  {
    // Epoch digest for DRep account holders: one notification when voting power
    // or delegator count moved beyond the thresholds. Idempotent per epoch via
    // the notifications event_key index, so running every pass is safe and the
    // 5-minute dispatcher picks the rows up on its next sweep. No second
    // koios.tip(): the epoch rides over from the history phase.
    name: 'drep-stats-digest',
    run: async (ctx) => {
      if (ctx.state.vpHistoryEpoch === null) return { items: 0 };
      const r = await runDrepStatsDigest(ctx.db, ctx.state.vpHistoryEpoch, Date.now());
      console.log(`[drep-stats] epoch=${ctx.state.vpHistoryEpoch} candidates=${r.candidates} fired=${r.fired}`);
      return { items: r.fired };
    },
  },
  {
    // Report-card percentiles for the DRep profiles: batch the per-DRep
    // participation and rationale rates with the exact profile semantics,
    // rank them in the cohort, and atomically swap the small table. Runs on
    // the same 6-hourly cadence as the profile sync. A failure here leaves
    // the previous percentiles standing.
    name: 'drep-report-card',
    run: async (ctx) => {
      const [candidates, qualifyingEpochs, voteCounts, rationaleCounts] = await Promise.all([
        listCohortCandidates(ctx.db),
        listQualifyingDecidedEpochs(ctx.db),
        listDrepVoteCounts(ctx.db),
        listDrepRationaleCounts(ctx.db),
      ]);
      const rows = computeReportCards({ candidates, qualifyingEpochs, voteCounts, rationaleCounts, now: Date.now() });
      await replaceReportCards(ctx.db, rows);
      console.log(`[drep-report-card] cohort=${rows.length} candidates=${candidates.length}`);
      return { items: rows.length };
    },
  },
  {
    // Sweep historical re-votes into drep_vote_history (drives the vote-change
    // stat and the "changed from X" chips for changes that predate live
    // tracking). A few actions drain per run; no-op once every action is swept.
    name: 'vote-history-sweep',
    run: async (ctx) => {
      const sweep = await backfillVoteHistorySweep({ koios: ctx.koios, db: ctx.db, now: Date.now() });
      if (sweep.pending > 0) {
        console.log(
          `[vote-history-sweep] pending=${sweep.pending} swept=${sweep.swept} inserted=${sweep.inserted} failed=${sweep.failed}`,
        );
      }
      return { items: sweep.inserted };
    },
  },
  {
    // One governance_epoch_stats row for the epoch the history phase captured
    // this run. Runs after the vote-history sweep so the vote-derived columns
    // see the freshest sweep state, and is recomputed every run: intra-epoch
    // votes and late delegator stamps converge onto the same row until the
    // epoch rolls. Metric definitions live in analytics/epochStatsContract.ts.
    name: 'epoch-stats',
    run: async (ctx) => {
      if (ctx.state.vpHistoryEpoch === null) return { items: 0 };
      const r = await syncCurrentEpochStats({
        db: ctx.db, koios: ctx.koios, cfg: ctx.cfg, epoch: ctx.state.vpHistoryEpoch,
      });
      console.log(`[epoch-stats] epoch=${ctx.state.vpHistoryEpoch} written=${r.written}`);
      return { items: r.written ? 1 : 0 };
    },
  },
  {
    // Self-draining historical backfill of governance_epoch_stats, oldest
    // epoch first, EPOCH_STATS_BACKFILL_PER_RUN epochs per run (transient
    // Koios fetches, nothing enters the history table). No-op once every
    // epoch since the network's first DRep power data is stored. Also repairs
    // the vote-derived columns of rows flagged incomplete once the
    // vote-history sweep drained.
    name: 'epoch-stats-backfill',
    run: async (ctx) => {
      if (ctx.state.vpHistoryEpoch === null) return { items: 0 };
      const r = await backfillEpochStats({
        db: ctx.db, koios: ctx.koios, cfg: ctx.cfg,
        currentEpoch: ctx.state.vpHistoryEpoch, budget: EPOCH_STATS_BACKFILL_PER_RUN,
      });
      if (r.inserted > 0 || r.repaired > 0 || r.remaining > 0) {
        console.log(`[epoch-stats-backfill] inserted=${r.inserted} repaired=${r.repaired} remaining=${r.remaining}`);
      }
      return { items: r.inserted + r.repaired };
    },
  },
  {
    // Backfill registration epochs for any DReps still missing one (drives the
    // participation stat). No-op once all are filled; only new DReps cost a page.
    name: 'registered-epochs',
    run: async (ctx) => {
      const reg = await backfillRegisteredEpochs({ koios: ctx.koios, db: ctx.db, cfg: ctx.cfg });
      console.log(`[drep-reg-backfill] missing=${reg.missing} resolved=${reg.resolved} pages=${reg.pages}`);
      return { items: reg.resolved };
    },
  },
  {
    // Mint profile slugs for newly named DReps (pure D1, no Koios). A profile
    // without a slug simply keeps its id URL until the next run.
    name: 'slugs',
    run: async (ctx) => {
      const slugs = await backfillDrepSlugs(ctx.db);
      if (slugs.missing > 0) console.log(`[drep-slugs] missing=${slugs.missing} assigned=${slugs.assigned}`);
      return { items: slugs.assigned };
    },
  },
  {
    // Mint profile slugs for newly named pools (pure D1, no Koios). Mirrors the
    // DRep slugs phase above; a pool without a slug simply keeps its id URL.
    name: 'pool-slugs',
    run: async (ctx) => {
      const slugs = await backfillPoolSlugs(ctx.db);
      if (slugs.missing > 0) console.log(`[pool-slugs] missing=${slugs.missing} assigned=${slugs.assigned}`);
      return { items: slugs.assigned };
    },
  },
  poolsPhase,
  {
    // Store new/changed avatars in R2 and GC orphaned objects. A failure here
    // must not fail the DRep sync that already succeeded (phase isolation).
    // Avatar fetches give up on a source after AVATAR_FETCH_MAX_ATTEMPTS failures
    // (see avatarStore), so a permanently broken image stops being retried every
    // run instead of pinning this sync at 'partial' forever.
    name: 'avatars',
    when: (ctx) => ctx.avatars !== null,
    run: async (ctx) => {
      // The when-gate above is the single skip decision; the cast only narrows
      // the type it already guaranteed.
      const bucket = ctx.avatars as R2Bucket;
      const a = await storeDrepAvatars({ db: ctx.db, bucket, fetchImpl: fetch, downscale: ctx.downscale });
      console.log(`[drep-avatars] scanned=${a.scanned} stored=${a.stored} cleared=${a.cleared} failed=${a.failed}`);
      const p = await mirrorPoolAvatars(ctx.db, bucket, ctx.downscale);
      const poolHashes = await listReferencedPoolImageHashes(ctx.db);
      const gc = await gcDrepAvatars({ db: ctx.db, bucket, nowMs: Date.now(), extraReferenced: poolHashes });
      console.log(`[drep-avatars-gc] scanned=${gc.scanned} deleted=${gc.deleted}`);
      return { items: a.stored + (p.items ?? 0), failed: a.failed + (p.failed ?? 0) };
    },
  },
  {
    // Rewrite avatars stored at full source resolution before the display-size
    // rule existed. Its own phase so a failure here neither fails the store
    // pass that already succeeded nor lands in its counters. Self-draining: the
    // queue is a D1 predicate that shrinks to nothing.
    name: 'avatar-refit',
    when: (ctx) => ctx.avatars !== null,
    run: async (ctx) => {
      const f = await refitStoredAvatars({
        db: ctx.db,
        bucket: ctx.avatars as R2Bucket,
        tables: REFIT_TABLES,
        downscale: ctx.downscale,
      });
      if (f.scanned > 0) {
        console.log(
          `[avatar-refit] scanned=${f.scanned} refitted=${f.refitted} savedKB=${Math.round(f.savedBytes / 1024)}`,
        );
      }
      return { items: f.refitted, failed: 0 };
    },
  },
];
