/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the governance_actions table.
// All queries use .prepare().bind(); never string-concatenated SQL.

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
      `INSERT OR IGNORE INTO governance_actions
         (id, proposal_id, type, title, abstract, rationale_html, anchor_url, anchor_hash, anchor_status,
          return_address, deposit, submitted_epoch, expiry_epoch, status, topic_id, created_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
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
  tallyEpoch: number | null;
  tallySyncedAt: number | null;
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
  tally_epoch: number | null;
  tally_synced_at: number | null;
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
    tallyEpoch: r.tally_epoch,
    tallySyncedAt: r.tally_synced_at,
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

/** Returns every still-active governance action (the tally/vote sync target). */
export async function getActiveGovernanceActions(db: D1Database): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare("SELECT * FROM governance_actions WHERE status = 'active'")
      .all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/** Batch-loads governance actions by topic id (no N+1 when rendering a list). */
export async function getGovernanceActionsByTopicIds(
  db: D1Database,
  topicIds: string[],
): Promise<Map<string, GovernanceAction>> {
  if (topicIds.length === 0) return new Map();

  const placeholders = topicIds.map(() => '?').join(', ');
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

export interface GovernanceTallyUpdate {
  id: string;
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
  tallyEpoch: number | null;
  tallySyncedAt: number;
  now: number;
}

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
             tally_epoch = ?, tally_synced_at = ?, last_synced_at = ?
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
      u.tallyEpoch,
      u.tallySyncedAt,
      u.now,
      u.id,
    )
    .run();
}
