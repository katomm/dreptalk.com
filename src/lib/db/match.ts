/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the /match quiz. Read-only.
// All queries use .prepare().bind(); never string-concatenated SQL.

import { SPECIAL_DREP_IDS } from '@/lib/dreps/special.js';
import { TERMINAL_STATUSES } from '@/lib/governance/view.js';
import type { MatrixVoteRow } from '@/lib/match/logic.js';
import { liveVoteSql } from './drepVotes.js';
import { sqlPlaceholders } from './sql.js';

export interface MatchCandidateRow {
  ga_id: string;
  type: string;
  title: string | null;
  abstract: string | null;
  topic_slug: string | null;
  expiry_epoch: number | null;
  yes: number;
  no: number;
  abstain: number;
}

/**
 * Head-count vote aggregates for the poolWindow most recently completed
 * actions that received at least one live DRep vote. Completed means the
 * shared TERMINAL_STATUSES set, deliberately not "status != 'active'",
 * which would wrongly include 'pending' (discovered but unverified) rows.
 */
export async function loadMatchCandidates(db: D1Database, poolWindow: number): Promise<MatchCandidateRow[]> {
  const statuses = [...TERMINAL_STATUSES];
  const rows = (
    await db
      .prepare(
        `SELECT ga.id AS ga_id, ga.type AS type,
                COALESCE(ga.title, t.title) AS title,
                ga.abstract AS abstract, t.slug AS topic_slug,
                ga.expiry_epoch AS expiry_epoch,
                SUM(CASE WHEN v.vote = 'Yes' THEN 1 ELSE 0 END) AS yes,
                SUM(CASE WHEN v.vote = 'No' THEN 1 ELSE 0 END) AS no,
                SUM(CASE WHEN v.vote = 'Abstain' THEN 1 ELSE 0 END) AS abstain
           FROM governance_actions ga
           LEFT JOIN topics t ON t.id = ga.topic_id
           JOIN drep_votes v ON v.ga_id = ga.id AND v.voter_role = 'DRep' AND ${liveVoteSql('v')}
          WHERE ga.status IN (${sqlPlaceholders(statuses)})
          GROUP BY ga.id
          ORDER BY ga.expiry_epoch DESC, ga.id ASC
          LIMIT ?`,
      )
      .bind(...statuses, poolWindow)
      .all<MatchCandidateRow>()
  ).results ?? [];
  return rows;
}

/**
 * Votes of eligible DReps for the selected questions, one row per vote.
 * Eligibility: active, named, listed (do_not_list honored on purpose, this
 * is a recommendation surface, unlike the plain directory listing), not a
 * pseudo-DRep, and at or below the power cap. The CAST spelling must stay
 * textually identical to idx_dreps_voting_power_int.
 */
export async function loadMatchMatrix(
  db: D1Database,
  gaIds: string[],
  powerCapLovelace: number,
): Promise<MatrixVoteRow[]> {
  if (gaIds.length === 0) return [];
  const specials = [...SPECIAL_DREP_IDS];
  const rows = (
    await db
      .prepare(
        `SELECT d.drep_id AS drep_id, d.slug AS slug, d.name AS name,
                d.image_content_hash AS image_content_hash, d.hex AS hex,
                d.has_script AS has_script,
                d.voting_power AS voting_power, d.delegator_count AS delegator_count,
                v.ga_id AS ga_id, v.vote AS vote,
                CASE WHEN r.voter_id IS NOT NULL THEN 1 ELSE 0 END AS has_rationale
           FROM drep_votes v
           JOIN dreps d ON d.drep_id = v.voter_id
           LEFT JOIN action_rationale r
             ON r.ga_id = v.ga_id AND r.voter_id = v.voter_id
            AND r.status = 'ok' AND trim(r.body_text) <> ''
          WHERE v.ga_id IN (${sqlPlaceholders(gaIds)})
            AND v.voter_role = 'DRep' AND ${liveVoteSql('v')}
            AND d.active = 1
            AND d.name IS NOT NULL AND trim(d.name) <> ''
            AND d.do_not_list = 0
            AND d.drep_id NOT IN (${sqlPlaceholders(specials)})
            AND d.voting_power IS NOT NULL
            AND CAST(d.voting_power AS INTEGER) <= ?`,
      )
      .bind(...gaIds, ...specials, powerCapLovelace)
      .all<MatrixVoteRow>()
  ).results ?? [];
  return rows;
}
