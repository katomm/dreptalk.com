// Phase registry for the DRep cron (0 */6): enumerate every registered DRep and
// persist profile data, then the derived per-epoch and per-profile passes.
// Two values genuinely flow between phases (the delegator counts observed by
// the dreps phase, and the epoch the voting-power history captured); they live
// in an explicitly typed per-run state rather than ad-hoc locals.

import { syncDreps, backfillRegisteredEpochs, backfillDrepSlugs } from '../../dreps/sync.js';
import { syncDrepVotingPowerHistory } from '../../dreps/votingPowerHistorySync.js';
import { runDrepStatsDigest } from '../../db/drepStatsDigest.js';
import { backfillVoteHistorySweep } from '../../governance/voteHistoryBackfill.js';
import { getFollowedDrepIds } from '../../db/delegatorFollows.js';
import {
  storeDrepAvatars,
  gcDrepAvatars,
  type ImageDownscaler,
} from '../../dreps/avatarStore.js';
import { listReferencedPoolImageHashes, backfillPoolSlugs } from '../../db/pools.js';
import type { CoreSyncContext } from './context.js';
import type { SyncPhaseDef } from './registry.js';
import { poolsPhase, mirrorPoolAvatars } from './shared.js';

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
    // profile sparkline. Self-healing: fetches only epochs not yet stored, prunes
    // the rolling window, and projects the latest two snapshots onto the dreps rows.
    // Inserts are chunked to stay under D1's 100 bound-parameter-per-query limit.
    // A fetch failure here must not fail the DRep sync that already succeeded.
    name: 'voting-power-history',
    run: async (ctx) => {
      const tip = await ctx.koios.tip();
      const r = await syncDrepVotingPowerHistory({
        koios: ctx.koios,
        db: ctx.db,
        currentEpoch: tip.epoch_no,
        observedDelegatorCounts: ctx.state.observedDelegatorCounts,
      });
      ctx.state.vpHistoryEpoch = tip.epoch_no;
      console.log(
        `[drep-vp-history] window=${r.window[0]}..${r.window[r.window.length - 1]} ` +
          `fetched=${r.fetchedEpochs.length} inserted=${r.inserted} pruned=${r.pruned} stamped=${r.stamped}`,
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
];
