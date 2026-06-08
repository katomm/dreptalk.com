/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the governance_actions table.
// All queries use .prepare().bind(); never string-concatenated SQL.

import { sqlPlaceholders } from './sql.js';

/** Returns the set of governance-action ids already stored, for the sync diff. */
export async function getKnownActionIds(db: D1Database): Promise<Set<string>> {
  const rows = (await db.prepare('SELECT id FROM governance_actions').all<{ id: string }>()).results ?? [];
  return new Set(rows.map((r) => r.id));
}

export interface NewGovernanceAction {
  id: string;
  proposalId: string | null;
  type: string;
  title: string | null;
  abstract: string | null;
  rationaleHtml: string | null;
  anchorUrl: string | null;
  anchorHash: string | null;
  anchorStatus: string;
  returnAddress: string | null;
  deposit: string | null;
  submittedEpoch: number | null;
  expiryEpoch: number | null;
  topicId: string;
  now: number;
}

/**
 * Builds the (idempotent) governance-action INSERT as a prepared statement so it
 * can be committed in the same atomic db.batch() as the topic and first post.
 */
export function buildInsertGovernanceAction(db: D1Database, a: NewGovernanceAction): D1PreparedStatement {
  return db
    .prepare(
      // status starts 'pending' (discovered, not yet verified). The tally/lifecycle
      // sync sets the real status (active / enacted / expired / dropped). Showing a
      // freshly discovered action as 'active' before we have checked would mislead.
      `INSERT OR IGNORE INTO governance_actions
         (id, proposal_id, type, title, abstract, rationale_html, anchor_url, anchor_hash, anchor_status,
          return_address, deposit, submitted_epoch, expiry_epoch, status, topic_id, created_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(
      a.id,
      a.proposalId,
      a.type,
      a.title,
      a.abstract,
      a.rationaleHtml,
      a.anchorUrl,
      a.anchorHash,
      a.anchorStatus,
      a.returnAddress,
      a.deposit,
      a.submittedEpoch,
      a.expiryEpoch,
      a.topicId,
      a.now,
      a.now,
    );
}

// Tally percentages are power-weighted for DRep/SPO and count-weighted for CC
// (as Koios computes them). Counts are the votes_cast numbers. All nullable
// until the tally sync first populates them.
export interface GovernanceAction {
  id: string;
  proposalId: string | null;
  type: string;
  title: string | null;
  abstract: string | null;
  rationaleHtml: string | null;
  anchorStatus: string;
  returnAddress: string | null;
  deposit: string | null;
  submittedEpoch: number | null;
  expiryEpoch: number | null;
  status: string;
  drepYes: number | null;
  drepNo: number | null;
  drepAbstain: number | null;
  spoYes: number | null;
  spoNo: number | null;
  spoAbstain: number | null;
  ccYes: number | null;
  ccNo: number | null;
  ccAbstain: number | null;
  drepYesPct: number | null;
  drepNoPct: number | null;
  spoYesPct: number | null;
  spoNoPct: number | null;
  ccYesPct: number | null;
  ccNoPct: number | null;
  drepVotedPower: number | null;
  tallyEpoch: number | null;
  tallySyncedAt: number | null;
  decidedEpoch: number | null;
  topicId: string | null;
  createdAt: number;
  lastSyncedAt: number;
}

interface GovernanceActionRow {
  id: string;
  proposal_id: string | null;
  type: string;
  title: string | null;
  abstract: string | null;
  rationale_html: string | null;
  anchor_status: string;
  return_address: string | null;
  deposit: string | null;
  submitted_epoch: number | null;
  expiry_epoch: number | null;
  status: string;
  drep_yes: number | null;
  drep_no: number | null;
  drep_abstain: number | null;
  spo_yes: number | null;
  spo_no: number | null;
  spo_abstain: number | null;
  cc_yes: number | null;
  cc_no: number | null;
  cc_abstain: number | null;
  drep_yes_pct: number | null;
  drep_no_pct: number | null;
  spo_yes_pct: number | null;
  spo_no_pct: number | null;
  cc_yes_pct: number | null;
  cc_no_pct: number | null;
  drep_voted_power: number | null;
  tally_epoch: number | null;
  tally_synced_at: number | null;
  decided_epoch: number | null;
  topic_id: string | null;
  created_at: number;
  last_synced_at: number;
}

function rowToGovernanceAction(r: GovernanceActionRow): GovernanceAction {
  return {
    id: r.id,
    proposalId: r.proposal_id,
    type: r.type,
    title: r.title,
    abstract: r.abstract,
    rationaleHtml: r.rationale_html,
    anchorStatus: r.anchor_status,
    returnAddress: r.return_address,
    deposit: r.deposit,
    submittedEpoch: r.submitted_epoch,
    expiryEpoch: r.expiry_epoch,
    status: r.status,
    drepYes: r.drep_yes,
    drepNo: r.drep_no,
    drepAbstain: r.drep_abstain,
    spoYes: r.spo_yes,
    spoNo: r.spo_no,
    spoAbstain: r.spo_abstain,
    ccYes: r.cc_yes,
    ccNo: r.cc_no,
    ccAbstain: r.cc_abstain,
    drepYesPct: r.drep_yes_pct,
    drepNoPct: r.drep_no_pct,
    spoYesPct: r.spo_yes_pct,
    spoNoPct: r.spo_no_pct,
    ccYesPct: r.cc_yes_pct,
    ccNoPct: r.cc_no_pct,
    drepVotedPower: r.drep_voted_power,
    tallyEpoch: r.tally_epoch,
    tallySyncedAt: r.tally_synced_at,
    decidedEpoch: r.decided_epoch,
    topicId: r.topic_id,
    createdAt: r.created_at,
    lastSyncedAt: r.last_synced_at,
  };
}

/** Returns the governance action attached to a topic, or null. Drives the GA thread header. */
export async function getGovernanceActionByTopicId(
  db: D1Database,
  topicId: string,
): Promise<GovernanceAction | null> {
  const row = await db
    .prepare('SELECT * FROM governance_actions WHERE topic_id = ?')
    .bind(topicId)
    .first<GovernanceActionRow>();
  return row ? rowToGovernanceAction(row) : null;
}

/**
 * Returns the governance actions the tally/vote sync should process: those still
 * 'active' and those 'pending' (discovered but not yet verified). Terminal actions
 * (ratified / enacted / expired / dropped) are frozen and excluded.
 */
export async function getSyncableGovernanceActions(db: D1Database): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare("SELECT * FROM governance_actions WHERE status IN ('active', 'pending')")
      .all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/**
 * Returns every governance action. The table holds one row per on-chain action
 * (low hundreds), so this is a single param-less query, used by the sorted
 * governance-actions list (which would otherwise exceed D1's bound-parameter cap
 * with a large IN clause).
 */
export async function getAllGovernanceActions(db: D1Database): Promise<GovernanceAction[]> {
  const rows = (
    await db.prepare('SELECT * FROM governance_actions').all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/** Batch-loads governance actions by topic id (no N+1 when rendering a list). */
export async function getGovernanceActionsByTopicIds(
  db: D1Database,
  topicIds: string[],
): Promise<Map<string, GovernanceAction>> {
  if (topicIds.length === 0) return new Map();

  const placeholders = sqlPlaceholders(topicIds);
  const rows = (
    await db
      .prepare(`SELECT * FROM governance_actions WHERE topic_id IN (${placeholders})`)
      .bind(...topicIds)
      .all<GovernanceActionRow>()
  ).results ?? [];

  const map = new Map<string, GovernanceAction>();
  for (const row of rows) {
    if (row.topic_id) map.set(row.topic_id, rowToGovernanceAction(row));
  }
  return map;
}

/**
 * Terminal actions still missing their voted-power backfill. Active/pending
 * actions get drep_voted_power from the normal tally, so they are excluded here.
 * Bounded by `limit` so a cron tick stays within Koios/subrequest budgets.
 */
export async function getActionsNeedingVotedPower(db: D1Database, limit: number): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare(
        `SELECT * FROM governance_actions
         WHERE proposal_id IS NOT NULL AND drep_voted_power IS NULL
           AND status NOT IN ('active', 'pending')
         LIMIT ?`,
      )
      .bind(limit)
      .all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/** Surgically sets only drep_voted_power for one action (leaves status/tally untouched). */
export async function updateVotedPower(db: D1Database, id: string, votedPower: number): Promise<void> {
  await db.prepare('UPDATE governance_actions SET drep_voted_power = ? WHERE id = ?').bind(votedPower, id).run();
}

// The tally + pct + epoch fields a sync writes: a subset of GovernanceAction, so
// the field list lives in exactly one place (no drift with tallyFields()).
export type GovernanceTally = Pick<
  GovernanceAction,
  | 'drepYes' | 'drepNo' | 'drepAbstain'
  | 'spoYes' | 'spoNo' | 'spoAbstain'
  | 'ccYes' | 'ccNo' | 'ccAbstain'
  | 'drepYesPct' | 'drepNoPct' | 'spoYesPct' | 'spoNoPct' | 'ccYesPct' | 'ccNoPct'
  | 'drepVotedPower'
  | 'tallyEpoch'
>;

export type GovernanceTallyUpdate = GovernanceTally & {
  id: string;
  status: string;
  // Epoch the action was decided (terminal), or null while active/pending.
  decidedEpoch: number | null;
  tallySyncedAt: number;
  now: number;
};

/** Updates the tally columns, pct columns, status, and sync timestamps in place. */
export async function updateGovernanceTallyAndStatus(
  db: D1Database,
  u: GovernanceTallyUpdate,
): Promise<void> {
  await db
    .prepare(
      `UPDATE governance_actions
         SET status = ?, drep_yes = ?, drep_no = ?, drep_abstain = ?,
             spo_yes = ?, spo_no = ?, spo_abstain = ?,
             cc_yes = ?, cc_no = ?, cc_abstain = ?,
             drep_yes_pct = ?, drep_no_pct = ?, spo_yes_pct = ?, spo_no_pct = ?,
             cc_yes_pct = ?, cc_no_pct = ?,
             drep_voted_power = ?,
             tally_epoch = ?, decided_epoch = ?, tally_synced_at = ?, last_synced_at = ?
       WHERE id = ?`,
    )
    .bind(
      u.status,
      u.drepYes,
      u.drepNo,
      u.drepAbstain,
      u.spoYes,
      u.spoNo,
      u.spoAbstain,
      u.ccYes,
      u.ccNo,
      u.ccAbstain,
      u.drepYesPct,
      u.drepNoPct,
      u.spoYesPct,
      u.spoNoPct,
      u.ccYesPct,
      u.ccNoPct,
      u.drepVotedPower,
      u.tallyEpoch,
      u.decidedEpoch,
      u.tallySyncedAt,
      u.now,
      u.id,
    )
    .run();
}
