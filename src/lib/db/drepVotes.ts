/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for drep_votes (on-chain votes that drive per-post badges).
// All queries use .prepare().bind(); never string-concatenated SQL.

export interface VoteInput {
  voterRole: string;
  voterId: string;
  voterHex: string | null;
  vote: string;
  /** Rationale anchor on the vote (Koios proposal_votes.meta_url); null when none. */
  metaUrl?: string | null;
}

// Bound parameters per row in the upsert; stays well under the SQLite limit.
const UPSERT_CHUNK = 100;

/**
 * Upserts on-chain votes for one governance action (INSERT OR REPLACE on the
 * (ga_id, voter_id) primary key), chunked. Returns the number of rows written.
 */
export async function upsertVotes(
  db: D1Database,
  gaId: string,
  votes: VoteInput[],
  now: number,
): Promise<number> {
  if (votes.length === 0) return 0;

  for (let i = 0; i < votes.length; i += UPSERT_CHUNK) {
    const chunk = votes.slice(i, i + UPSERT_CHUNK);
    const stmts = chunk.map((v) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(gaId, v.voterRole, v.voterId, v.voterHex, v.vote, v.metaUrl ?? null, now),
    );
    await db.batch(stmts);
  }
  return votes.length;
}

/** One row of a DRep's voting history: the vote plus its action's context. */
export interface DrepVoteHistoryRow {
  ga_id: string;
  vote: string;
  title: string | null;
  type: string;
  status: string;
  decided_epoch: number | null;
  topic_slug: string | null;
}

/**
 * A DRep's on-chain votes (role 'DRep'), joined to the action and (when present)
 * its forum topic for linking, ordered by the action's decided epoch then id.
 * Uses idx_drep_votes_voter. Default limit 20, capped 50.
 */
export async function getDrepVotingHistory(
  db: D1Database,
  voterId: string,
  opts?: { limit?: number; offset?: number },
): Promise<DrepVoteHistoryRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 50);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const rows = (
    await db
      .prepare(
        `SELECT v.ga_id AS ga_id, v.vote AS vote, g.title AS title, g.type AS type,
                g.status AS status, g.decided_epoch AS decided_epoch, t.slug AS topic_slug
         FROM drep_votes v
         JOIN governance_actions g ON g.id = v.ga_id
         LEFT JOIN topics t ON t.id = g.topic_id
         WHERE v.voter_id = ? AND v.voter_role = 'DRep'
         ORDER BY g.decided_epoch DESC, g.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(voterId, limit, offset)
      .all<DrepVoteHistoryRow>()
  ).results ?? [];
  return rows;
}

/** Count of a DRep's recorded on-chain votes (role 'DRep'). Uses idx_drep_votes_voter. */
export async function countDrepVotes(db: D1Database, voterId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM drep_votes WHERE voter_id = ? AND voter_role = 'DRep'`)
    .bind(voterId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** One DRep's vote on an action, with the joined identity fields for rendering + linking. */
export interface ActionVoterRow {
  voter_id: string;
  vote: string;
  voting_power: string | null;
  hex: string | null;
  voter_hex: string | null;
  image_url: string | null;
}

/**
 * DRep votes (role 'DRep') on one action, joined to dreps for identity + power,
 * ordered by voting power desc (unknown power last). Filtered by ga_id (the leading
 * column of the (ga_id, voter_id) primary key). Default limit 50, capped 200.
 */
export async function getActionVoters(
  db: D1Database,
  gaId: string,
  opts?: { limit?: number; offset?: number },
): Promise<ActionVoterRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const rows = (
    await db
      .prepare(
        `SELECT v.voter_id AS voter_id, v.vote AS vote,
                d.voting_power AS voting_power, d.hex AS hex, v.voter_hex AS voter_hex, d.image_url AS image_url
         FROM drep_votes v
         LEFT JOIN dreps d ON d.drep_id = v.voter_id
         WHERE v.ga_id = ? AND v.voter_role = 'DRep'
         ORDER BY (d.voting_power IS NULL), CAST(d.voting_power AS INTEGER) DESC, v.voter_id
         LIMIT ? OFFSET ?`,
      )
      .bind(gaId, limit, offset)
      .all<ActionVoterRow>()
  ).results ?? [];
  return rows;
}

/** Count of DRep votes (role 'DRep') on one action. */
export async function countActionVoters(db: D1Database, gaId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM drep_votes WHERE ga_id = ? AND voter_role = 'DRep'`)
    .bind(gaId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Returns the votes on one action keyed by voter id, for the per-post badge.
 * The thread view matches each post author's drep_id / pool_id / cc_cred here.
 */
export async function getVotesByGaId(
  db: D1Database,
  gaId: string,
): Promise<Map<string, { role: string; vote: string }>> {
  const rows = (
    await db
      .prepare('SELECT voter_id, voter_role, vote FROM drep_votes WHERE ga_id = ?')
      .bind(gaId)
      .all<{ voter_id: string; voter_role: string; vote: string }>()
  ).results ?? [];

  const map = new Map<string, { role: string; vote: string }>();
  for (const r of rows) {
    map.set(r.voter_id, { role: r.voter_role, vote: r.vote });
  }
  return map;
}

export interface DrepRationaleStats {
  total: number;
  without: number;
  withRationale: number;
}

/**
 * How often a DRep attached a rationale anchor to its vote vs not. "Without"
 * means the vote carried no meta_url (NULL or empty string).
 */
export async function getDrepRationaleStats(db: D1Database, voterId: string): Promise<DrepRationaleStats> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN meta_url IS NULL OR meta_url = '' THEN 1 ELSE 0 END) AS without
       FROM drep_votes WHERE voter_id = ? AND voter_role = 'DRep'`,
    )
    .bind(voterId)
    .first<{ total: number; without: number }>();
  const total = row?.total ?? 0;
  const without = row?.without ?? 0;
  return { total, without, withRationale: total - without };
}

export interface DrepVoteBreakdown {
  yes: number;
  no: number;
  abstain: number;
  total: number;
}

/**
 * Yes / No / Abstain counts for a DRep (role 'DRep'), by raw vote count (1 action
 * = 1 vote). One grouped scan over idx_drep_votes_voter. Any vote value other than
 * Yes/No (e.g. Abstain) folds into abstain.
 */
export async function getDrepVoteBreakdown(db: D1Database, voterId: string): Promise<DrepVoteBreakdown> {
  const rows = (
    await db
      .prepare(`SELECT vote, COUNT(*) AS n FROM drep_votes WHERE voter_id = ? AND voter_role = 'DRep' GROUP BY vote`)
      .bind(voterId)
      .all<{ vote: string; n: number }>()
  ).results ?? [];
  const out: DrepVoteBreakdown = { yes: 0, no: 0, abstain: 0, total: 0 };
  for (const r of rows) {
    const v = r.vote.toLowerCase();
    if (v === 'yes') out.yes += r.n;
    else if (v === 'no') out.no += r.n;
    else out.abstain += r.n;
    out.total += r.n;
  }
  return out;
}

export interface DrepParticipation {
  eligible: number;
  voted: number;
}

/**
 * Participation over concluded governance actions the DRep could vote on.
 *  - eligible: actions decided at or after the DRep registered that carry at
 *    least one DRep vote. The window uses decided_epoch, not expiry_epoch:
 *    ratified/dropped actions close before their nominal expiry, so expiry would
 *    count actions already decided before the DRep registered. Actions with zero
 *    DRep votes were not DRep-votable at all (bootstrap-phase parameter changes
 *    and hard forks were decided by the constitutional committee and SPOs alone,
 *    the ledger rejected DRep votes), so they stay out of the denominator.
 *  - voted: those the DRep cast any vote on (Yes/No/Abstain all count).
 * Returns null when registeredEpoch is unknown (not yet backfilled), so the UI
 * shows "pending" rather than a misleading 0%.
 */
export async function getDrepParticipation(
  db: D1Database,
  voterId: string,
  registeredEpoch: number | null,
): Promise<DrepParticipation | null> {
  if (registeredEpoch == null) return null;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS eligible, COUNT(v.ga_id) AS voted
       FROM governance_actions g
       LEFT JOIN drep_votes v ON v.ga_id = g.id AND v.voter_id = ? AND v.voter_role = 'DRep'
       WHERE g.decided_epoch IS NOT NULL
         AND g.decided_epoch >= ?
         AND EXISTS (SELECT 1 FROM drep_votes dv WHERE dv.ga_id = g.id AND dv.voter_role = 'DRep')`,
    )
    .bind(voterId, registeredEpoch)
    .first<{ eligible: number; voted: number }>();
  return { eligible: row?.eligible ?? 0, voted: row?.voted ?? 0 };
}
