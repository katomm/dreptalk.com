// Phase registry for the vote cron (*/20): refresh the per-post vote lists for
// active actions. Vote lists are larger than the tally summary, but the budget
// covers the whole active set in one run, so each active action's vote list
// refreshes every run. Per-action vote pagination is bounded (see MAX_VOTE_PAGES
// in tallySync) so one action with a pathologically long vote list cannot run
// an invocation out of CPU and leave the run stuck mid-loop.

import {
  syncGovernanceVotes,
  backfillFinalizedVotes,
  backfillVoteMetaHashes,
  reconcilePendingVotes,
} from '../../governance/tallySync.js';
import { syncVoteRationales } from '../../governance/rationaleSync.js';
import { syncCommitteeVoteMeta } from '../../governance/committeeMetaSync.js';
import { backfillRationaleText } from '../../db/rationaleTextBackfill.js';
import { getFollowedDrepIds } from '../../db/delegatorFollows.js';
import type { ImageDownscaler } from '../../dreps/avatarStore.js';
import { recomputeCommitteePct } from '../../db/committee.js';
import { deleteExpiredPending } from '../../db/pendingMultisigTx.js';
import { awardBadges } from '../../badges/engine.js';
import type { CoreSyncContext } from './context.js';
import type { SyncPhaseDef } from './registry.js';
import { poolsPhase, mirrorPoolAvatars } from './shared.js';

export interface VoteSyncContext extends CoreSyncContext {
  /** Top of the hour (scheduled minute === 0): the badge pass runs. */
  hourly: boolean;
  /** R2 bucket for mirrored logos; the avatar phase is skipped without it. */
  avatars: R2Bucket | null;
  /** Downscaler from the Images binding, undefined when the binding is absent. */
  downscale: ImageDownscaler | undefined;
}

// Per-run vote-sync budget: proposal_votes is paginated and heavier than the tally
// summary, so the vote sync is bounded and paced. Sized to cover the whole active
// set in one run (active actions currently number ~20), so that on the */20
// cadence every active action's vote list refreshes each run rather than rotating
// a 12-wide window and leaving the tail hours stale.
const VOTE_LIMIT = 25;
const VOTE_PACE_MS = 200;

export const votePhases: readonly SyncPhaseDef<VoteSyncContext>[] = [
  {
    name: 'votes',
    primary: true,
    run: async (ctx) => {
      // Loaded once per run and threaded ONLY into the live sync below: a
      // qualifying followed-DRep vote gets a delegator fan-out job atomically with
      // its upsert. The finalized-backfill phase further down deliberately does
      // NOT receive this set, since it re-writes historical votes.
      const followedDrepIds = await getFollowedDrepIds(ctx.db);
      const r = await syncGovernanceVotes({
        koios: ctx.koios, db: ctx.db, now: ctx.now, limit: VOTE_LIMIT, paceMs: VOTE_PACE_MS, followedDrepIds,
      });
      console.log(`[gov-votes] actions=${r.actions} votes=${r.votes} failed=${r.failed}`);
      return { items: r.votes, failed: r.failed };
    },
  },
  poolsPhase,
  {
    name: 'pool-avatars',
    when: (ctx) => ctx.avatars !== null,
    // The when-gate above is the single skip decision; the cast only narrows
    // the type it already guaranteed.
    run: (ctx) => mirrorPoolAvatars(ctx.db, ctx.avatars as R2Bucket, ctx.downscale),
  },
  {
    // Fetch and store CIP-100/CIP-136 vote rationale anchors for votes that have
    // a metadata_url but no rationale stored yet. Paced with the same interval as
    // the votes phase to avoid hammering anchor hosts. Not the primary phase.
    name: 'rationales',
    run: async (ctx) => {
      const r = await syncVoteRationales({ db: ctx.db, now: Date.now(), paceMs: VOTE_PACE_MS });
      console.log(`[vote-rationales] fetched=${r.fetched} ok=${r.ok} empty=${r.empty} failed=${r.failed}`);
      return { items: r.ok, failed: r.failed };
    },
  },
  {
    // Constitutional-committee votes are excluded from the DRep rationale queue
    // (role='DRep', power-gated), so fetch their anchors here: stores the CC
    // rationale and the member's self-declared name from one fetch. Tiny set.
    name: 'committee-meta',
    run: async (ctx) => {
      const r = await syncCommitteeVoteMeta({ db: ctx.db, now: Date.now(), paceMs: VOTE_PACE_MS });
      if (r.fetched > 0) console.log(`[committee-meta] fetched=${r.fetched} ok=${r.ok} named=${r.named} failed=${r.failed}`);
      return { items: r.named, failed: r.failed };
    },
  },
  {
    // One-time historical fill for finalised actions never vote-synced. Small,
    // paced budget so the run stays light; drains over many hours.
    name: 'finalized-backfill',
    run: async (ctx) => {
      const bf = await backfillFinalizedVotes({ koios: ctx.koios, db: ctx.db, now: ctx.now, limit: 6, paceMs: VOTE_PACE_MS });
      console.log(`[gov-votes-backfill] actions=${bf.actions} votes=${bf.votes} failed=${bf.failed}`);
      return { items: bf.votes, failed: bf.failed };
    },
  },
  {
    // Recompute the committee yes-percentage to the ledger-exact value once an
    // action's votes are synced, replacing Koios' committee_yes_pct (which miscounts
    // rotated hot keys and resigned members). Only-changed and idempotent, so it
    // converges as the finalized-vote backfill drains.
    name: 'committee-pct',
    run: async (ctx) => {
      const tip = await ctx.koios.tip();
      const r = await recomputeCommitteePct(ctx.db, tip.epoch_no, 100);
      if (r.updated > 0 || r.skipped > 0) console.log(`[committee-pct] scanned=${r.scanned} updated=${r.updated} skipped=${r.skipped}`);
      return { items: r.updated };
    },
  },
  {
    // One-time historical fill: votes synced before meta_hash capture have no
    // hash, so the rationale queue skips them. Hashes are resolved per vote via
    // /vote_list (see backfillVoteMetaHashes for why not /proposal_votes);
    // self-draining, becomes a no-op once every vote is filled.
    name: 'meta-hash-backfill',
    run: async (ctx) => {
      const bf = await backfillVoteMetaHashes({ koios: ctx.koios, db: ctx.db, limit: 25, paceMs: VOTE_PACE_MS });
      console.log(`[gov-rationale-hash-backfill] votes=${bf.votes} failed=${bf.failed}`);
      return { items: bf.votes, failed: bf.failed };
    },
  },
  {
    // One-time historical fill: rationales ingested before the FTS migration have
    // an empty body_text. Strip their stored body_html into body_text so they enter
    // the rationale search index. Self-draining, becomes a no-op once all are filled.
    name: 'rationale-text-backfill',
    run: async (ctx) => {
      const bf = await backfillRationaleText(ctx.db, 200);
      console.log(`[rationale-text-backfill] filled=${bf.filled}`);
      return { items: bf.filled, failed: 0 };
    },
  },
  {
    // Flag optimistic votes that never appeared on chain. Runs after the
    // authoritative sync so any vote that DID land has already cleared its pending
    // marker; only stragglers (tx dropped/rolled back) are flagged here.
    name: 'reconcile-pending',
    run: async (ctx) => {
      const changed = await reconcilePendingVotes(ctx.db, Math.floor(Date.now() / 1000));
      if (changed > 0) console.log(`[gov-votes-reconcile] failed=${changed}`);
      return { items: changed };
    },
  },
  {
    // Remove multisig pending votes whose collection window has elapsed. Runs
    // alongside reconcile-pending; a cleanup failure must not abort the sync.
    name: 'expire-multisig',
    run: async (ctx) => {
      const deleted = await deleteExpiredPending(ctx.db, Math.floor(Date.now() / 1000));
      if (deleted > 0) console.log(`[multisig-expire] deleted=${deleted}`);
      return { items: deleted };
    },
  },
  {
    // Award achievement badges from the freshly synced data: a set-based full
    // pass over D1 (no Koios calls) that writes only new awards and tier upgrades.
    // Hourly-gated: the pass makes several full-scan aggregates over drep_votes and
    // is the biggest D1 consumer on this worker; badges are cumulative, so a fresh
    // award taking up to an hour to appear is fine and cuts the frequency 3x on the
    // 20-minute vote cron.
    name: 'badges',
    when: (ctx) => ctx.hourly,
    run: async (ctx) => {
      const badges = await awardBadges({ db: ctx.db, cfg: ctx.cfg, now: Date.now() });
      console.log(`[badges] desired=${badges.desired} written=${badges.written}`);
      return { items: badges.written };
    },
  },
];
