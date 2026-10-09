/// <reference types="@cloudflare/workers-types" />
// Decided governance actions joined to the per-epoch backbone for the
// analytics hub's effective-representation panel. The denominator is the
// decision epoch's representative total from governance_epoch_stats
// (specials excluded by construction), never a live table sum, so every
// action is measured against the stake distribution that actually decided it.
import { bucketsDrifted } from '../governance/fullStakeView.js';
import { concludedStatusSql } from './sql.js';
export interface DecidedActionRepresentation {
  id: string;
  title: string | null;
  topicSlug: string | null;
  type: string;
  decidedEpoch: number;
  votedPower: number | null;
  votesCast: number;
  totalDrepPower: string | null;
  poweredDrepCount: number | null;
}

export async function listDecidedActionsForRepresentation(
  db: D1Database,
  opts: { limit?: number } = {},
): Promise<DecidedActionRepresentation[]> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 12));
  const rows = (
    await db
      .prepare(
        `SELECT g.id, g.title, t.slug AS topic_slug, g.type, g.decided_epoch,
                g.drep_voted_power, g.drep_yes_pct, g.drep_yes_power, g.drep_no_side_power,
                COALESCE(g.drep_yes, 0) + COALESCE(g.drep_no, 0) + COALESCE(g.drep_abstain, 0) AS votes_cast,
                s.total_drep_power, s.powered_drep_count
           FROM governance_actions g
           LEFT JOIN topics t ON t.id = g.topic_id
           LEFT JOIN governance_epoch_stats s ON s.epoch = g.decided_epoch
          WHERE g.decided_epoch IS NOT NULL AND ${concludedStatusSql('g')}
          ORDER BY g.decided_epoch DESC, g.id ASC
          LIMIT ?`,
      )
      .bind(limit)
      .all<{ id: string; title: string | null; topic_slug: string | null; type: string; decided_epoch: number; drep_voted_power: number | null; drep_yes_pct: number | null; drep_yes_power: number | null; drep_no_side_power: string | null; votes_cast: number; total_drep_power: string | null; powered_drep_count: number | null }>()
  ).results ?? [];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    topicSlug: r.topic_slug,
    type: r.type,
    decidedEpoch: r.decided_epoch,
    // Same drift gate as the governance row mapper: voted power backfilled from a
    // later ledger state than the frozen tally is not measured against this epoch.
    votedPower: bucketsDrifted({
      actionType: r.type, body: 'DRep', storedPct: r.drep_yes_pct, yesPower: r.drep_yes_power, noSidePower: r.drep_no_side_power,
    })
      ? null
      : r.drep_voted_power,
    votesCast: r.votes_cast,
    totalDrepPower: r.total_drep_power,
    poweredDrepCount: r.powered_drep_count,
  }));
}
