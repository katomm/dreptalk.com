/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for drep_votes (on-chain votes that drive per-post badges).
// All queries use .prepare().bind(); never string-concatenated SQL.
import {
  buildArchiveStatements,
  computeSupersededChanges,
  loadExistingVotes,
  readChangedRationaleBodies,
  type ExistingVoteRow,
} from './voteHistory.js';
import { buildJobInsert, type FanoutEventType } from './fanoutJobs.js';
import { voteBucket } from '@/lib/governance/view.js';

export interface VoteInput {
  voterRole: string;
  voterId: string;
  voterHex: string | null;
  vote: string;
  /** Rationale anchor on the vote (Koios proposal_votes.meta_url); null when none. */
  metaUrl?: string | null;
  /** blake2b-256 hash of the vote anchor doc (Koios meta_hash); null when absent. */
  metaHash?: string | null;
  /** Unix seconds of the vote tx (Koios proposal_votes.block_time); null when unknown. */
  blockTime?: number | null;
  /** Decisive voting power in lovelace (DRep/SPO); null for CC or when unresolved. */
  votedPower?: number | null;
}

// Max rows per db.batch() call in upsertVotes. D1 caps bound params at 100 per
// query; each INSERT binds 10 params (ga_id, voter_role, voter_id, voter_hex,
// vote, meta_url, meta_hash, block_time, synced_at, voted_power), so floor(100/10) = 10.
const UPSERT_CHUNK = 10;

export interface UpsertVotesOptions {
  /**
   * When present, the set of DRep ids that have at least one follower to notify.
   * Passing it turns on delegator fan-out: a qualifying DRep vote gets a
   * notification_fanout_jobs row inserted in the SAME batch as its drep_votes
   * upsert (so job creation is atomic with the vote). Omit it (the sync backfill
   * does) to write votes without emitting any events.
   */
  followedDrepIds?: Set<string>;
}

/**
 * The vote upsert statements (one row each, 10 binds). Uses ON CONFLICT DO
 * UPDATE (not INSERT OR REPLACE) so a re-sync with a missing voted_power never
 * nulls an already stored value: voted_power = COALESCE(new, existing). The
 * on-chain path resets local_status / tx_hash to NULL (it supersedes any
 * optimistic row).
 */
export function buildVoteUpsertStatements(
  db: D1Database,
  gaId: string,
  votes: VoteInput[],
  now: number,
): D1PreparedStatement[] {
  return votes.map((v) =>
    db
      .prepare(
        `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, meta_hash, block_time, synced_at, voted_power, local_status, tx_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(ga_id, voter_id) DO UPDATE SET
           voter_role = excluded.voter_role,
           voter_hex  = excluded.voter_hex,
           vote       = excluded.vote,
           meta_url   = excluded.meta_url,
           meta_hash  = excluded.meta_hash,
           block_time = excluded.block_time,
           synced_at  = excluded.synced_at,
           voted_power = COALESCE(excluded.voted_power, drep_votes.voted_power),
           local_status = NULL,
           tx_hash = NULL`,
      )
      .bind(gaId, v.voterRole, v.voterId, v.voterHex, v.vote, v.metaUrl ?? null, v.metaHash ?? null, v.blockTime ?? null, now, v.votedPower ?? null),
  );
}

/**
 * Classifies the incoming votes against the stored rows and builds a fan-out job
 * INSERT for each qualifying followed-DRep vote (dropped into the caller's batch,
 * so the job commits with the vote). Only role 'DRep' votes whose voterId is in
 * followedDrepIds qualify:
 *  - `voted`   : no stored row, OR the stored row was a pending self-cast now
 *                confirmed on chain (local_status != null).
 *  - `re_voted`: an authoritative row (local_status null) whose vote changed to a
 *                strictly newer block_time.
 *  - otherwise : no job (anchor-only change, or not actually newer).
 * `now` is unix milliseconds; source_time / created_at are seconds. When a vote
 * has no block_time, the observed second is used for both source_time and the
 * event_key and payload.sourceTimeApprox is set. `title` is a best-effort action
 * title for the payload.
 */
export function classifyVoteJobs(
  db: D1Database,
  gaId: string,
  incoming: VoteInput[],
  existing: Map<string, ExistingVoteRow>,
  followedDrepIds: Set<string>,
  now: number,
  title: string | null,
): D1PreparedStatement[] {
  const observedAtSec = Math.floor(now / 1000);
  const stmts: D1PreparedStatement[] = [];
  for (const v of incoming) {
    if (v.voterRole !== 'DRep' || !followedDrepIds.has(v.voterId)) continue;
    const old = existing.get(v.voterId);

    let kind: 'voted' | 're_voted' | null = null;
    if (!old || old.local_status != null) kind = 'voted';
    else if (old.vote !== v.vote && v.blockTime != null && old.block_time != null && v.blockTime > old.block_time) kind = 're_voted';
    if (!kind) continue;

    const approx = v.blockTime == null;
    const sourceTime = v.blockTime ?? observedAtSec;
    const prefix = kind === 'voted' ? 'drep-vote' : 'drep-revote';
    const eventType: FanoutEventType = kind === 'voted' ? 'delegator_drep_voted' : 'delegator_drep_re_voted';
    const payload: Record<string, unknown> = { sourceTime, gaId, title };
    if (approx) payload.sourceTimeApprox = true;

    stmts.push(
      buildJobInsert(db, {
        eventKey: `${prefix}:${v.voterId}:${gaId}:${sourceTime}`,
        eventType,
        subjectId: v.voterId,
        sourceTime,
        payload: JSON.stringify(payload),
        createdAt: observedAtSec,
      }),
    );
  }
  return stmts;
}

/** Best-effort action title for a fan-out payload; null when unknown. */
async function lookupActionTitle(db: D1Database, gaId: string): Promise<string | null> {
  const row = await db.prepare('SELECT title FROM governance_actions WHERE id = ?').bind(gaId).first<{ title: string | null }>();
  return row?.title ?? null;
}

/**
 * Upserts on-chain votes for one governance action (ON CONFLICT DO UPDATE on the
 * (ga_id, voter_id) primary key), chunked. For each chunk, the archive of any
 * rows the write supersedes, the vote upserts, and (when followedDrepIds is
 * passed) the delegator fan-out jobs all land in ONE db.batch, so history, vote
 * and job commit atomically together. The existing-rows SELECT and the changed
 * voters' rationale bodies are read once up front and shared across chunks. The
 * upsert uses ON CONFLICT so a missing voted_power (a DRep/pool not yet resolved)
 * never nulls an already stored value: voted_power = COALESCE(new, existing);
 * local_status / tx_hash reset to NULL (an on-chain row supersedes any optimistic one).
 * Returns the number of rows written.
 */
export async function upsertVotes(
  db: D1Database,
  gaId: string,
  votes: VoteInput[],
  now: number,
  opts?: UpsertVotesOptions,
): Promise<number> {
  if (votes.length === 0) return 0;

  const followedDrepIds = opts?.followedDrepIds;
  const existing = await loadExistingVotes(db, gaId);

  // Rationale bodies for archiving, read once for every superseded voter.
  const changed = computeSupersededChanges(votes, existing);
  const bodies = changed.length
    ? await readChangedRationaleBodies(db, gaId, changed.map((c) => c.old.voter_id))
    : new Map<string, string | null>();

  // Title only when we might emit a job (best-effort, one SELECT).
  const emitJobs = followedDrepIds != null && followedDrepIds.size > 0;
  const title = emitJobs ? await lookupActionTitle(db, gaId) : null;

  for (let i = 0; i < votes.length; i += UPSERT_CHUNK) {
    const chunk = votes.slice(i, i + UPSERT_CHUNK);
    const archiveStmts = buildArchiveStatements(db, gaId, chunk, existing, bodies, now);
    const voteStmts = buildVoteUpsertStatements(db, gaId, chunk, now);
    const jobStmts = emitJobs ? classifyVoteJobs(db, gaId, chunk, existing, followedDrepIds, now, title) : [];
    await db.batch([...archiveStmts, ...voteStmts, ...jobStmts]);
  }
  return votes.length;
}

/** An anchored vote on a finalized action whose anchor hash is still missing. */
export interface VoteNeedingMetaHash {
  ga_id: string;
  proposal_id: string;
  voter_id: string;
  meta_url: string;
  /** Unix seconds of the vote tx as stored locally; null for pre-capture rows. */
  block_time: number | null;
}

/**
 * Votes on finalized actions that carry an anchor URL but no anchor hash
 * (synced before meta_hash capture existed). The rationale queue skips them
 * until the hash is backfilled. Bounded by `limit`.
 */
export async function getVotesNeedingMetaHash(db: D1Database, limit: number): Promise<VoteNeedingMetaHash[]> {
  const rows = (
    await db
      .prepare(
        `SELECT v.ga_id, g.proposal_id, v.voter_id, v.meta_url, v.block_time
         FROM drep_votes v
         JOIN governance_actions g ON g.id = v.ga_id
         WHERE g.status NOT IN ('active', 'pending')
           AND g.proposal_id IS NOT NULL
           AND v.meta_url IS NOT NULL AND v.meta_url != ''
           AND (v.meta_hash IS NULL OR v.meta_hash = '')
         LIMIT ?`,
      )
      .bind(limit)
      .all<VoteNeedingMetaHash>()
  ).results ?? [];
  return rows;
}

/** Fills the anchor hash on one stored vote without touching the rest of the row. */
export async function setVoteMetaHash(db: D1Database, gaId: string, voterId: string, metaHash: string): Promise<void> {
  await db
    .prepare('UPDATE drep_votes SET meta_hash = ? WHERE ga_id = ? AND voter_id = ?')
    .bind(metaHash, gaId, voterId)
    .run();
}

/**
 * SQL predicate for votes that count publicly: synced on-chain rows
 * (local_status NULL) plus optimistic local rows still pending, excluding the
 * ones markStalePendingVotesFailed flagged as never confirmed. One source for
 * every role: only recordLocalVote writes a local_status and it is DRep-only
 * today, but the SPO/CC reads carry the same guard so an optimistic path added
 * for them later cannot leak failed votes into public reads. Pass the query's
 * table alias (e.g. 'v') or nothing for unaliased queries.
 */
export function liveVoteSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `(${a}local_status IS NULL OR ${a}local_status <> 'failed')`;
}

/** One row of a DRep's voting history: the vote plus its action's context. */
export interface DrepVoteHistoryRow {
  ga_id: string;
  vote: string;
  title: string | null;
  type: string;
  status: string;
  decided_epoch: number | null;
  submitted_epoch: number | null;
  topic_slug: string | null;
  meta_url: string | null;
  /** Unix seconds of the vote tx, for the "voted N ago" stamp; null when unknown. */
  block_time: number | null;
  /** Rendered rationale HTML for this vote (from action_rationale), or null when
   *  the DRep attached none or it has not been fetched/rendered yet. */
  rationale_html: string | null;
}

/**
 * A DRep's on-chain votes (role 'DRep'), joined to the action and (when present)
 * its forum topic for linking, ordered by vote time (most recent vote first) so
 * a freshly cast or changed vote leads. Votes on still-open actions have no
 * decided epoch, so ordering by the vote's block_time (not the action's decided
 * epoch, which is NULL and would sink them) keeps the history a true activity
 * timeline. Rows with no block_time fall back to the action's decided epoch/id.
 * Uses idx_drep_votes_voter. Default limit 20, capped 500. Pass `confirmedOnly`
 * to additionally require `local_status IS NULL`, so a delegator viewing their
 * DRep's history never sees a still-optimistic (unconfirmed) self-cast. Pass
 * `rationalePresenceOnly` when the caller only needs to know a rationale exists
 * (e.g. to link a "view rationale" page): rationale_html then carries a '1'
 * sentinel instead of the full body_html, so a 500-row pull does not drag KBs
 * of rendered HTML the caller never renders.
 */
export async function getDrepVotingHistory(
  db: D1Database,
  voterId: string,
  opts?: { limit?: number; offset?: number; confirmedOnly?: boolean; rationalePresenceOnly?: boolean },
): Promise<DrepVoteHistoryRow[]> {
  // The ceiling is a runaway guard, sized so a profile can render a DRep's
  // complete history (a vote per action; mainnet has ~150 actions so far).
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 500);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const confirmedClause = opts?.confirmedOnly ? 'AND v.local_status IS NULL' : '';
  // Presence sentinel vs the full body: callers that only test truthiness skip
  // the (potentially multi-KB) HTML transfer.
  const rationaleCol = opts?.rationalePresenceOnly
    ? `CASE WHEN r.body_html IS NOT NULL AND trim(r.body_html) <> '' THEN '1' ELSE NULL END`
    : 'r.body_html';
  const rows = (
    await db
      .prepare(
        `SELECT v.ga_id AS ga_id, v.vote AS vote, g.title AS title, g.type AS type,
                g.status AS status, g.decided_epoch AS decided_epoch,
                g.submitted_epoch AS submitted_epoch, t.slug AS topic_slug,
                v.meta_url AS meta_url, v.block_time AS block_time, ${rationaleCol} AS rationale_html
         FROM drep_votes v
         JOIN governance_actions g ON g.id = v.ga_id
         LEFT JOIN topics t ON t.id = g.topic_id
         LEFT JOIN action_rationale r ON r.ga_id = v.ga_id AND r.voter_id = v.voter_id
         WHERE v.voter_id = ? AND v.voter_role = 'DRep'
           AND ${liveVoteSql('v')}
           ${confirmedClause}
         ORDER BY (v.block_time IS NULL), v.block_time DESC, g.decided_epoch DESC, g.id DESC
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
    .prepare(`SELECT COUNT(*) AS n FROM drep_votes WHERE voter_id = ? AND voter_role = 'DRep' AND ${liveVoteSql()}`)
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
  /** Unix seconds of the vote tx; used to tell whether it predates ratification. */
  block_time: number | null;
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
                d.voting_power AS voting_power, d.hex AS hex, v.voter_hex AS voter_hex, d.image_url AS image_url,
                v.block_time AS block_time
         FROM drep_votes v
         LEFT JOIN dreps d ON d.drep_id = v.voter_id
         WHERE v.ga_id = ? AND v.voter_role = 'DRep'
           AND ${liveVoteSql('v')}
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
    .prepare(`SELECT COUNT(*) AS n FROM drep_votes WHERE ga_id = ? AND voter_role = 'DRep' AND ${liveVoteSql()}`)
    .bind(gaId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * SPO votes (role 'SPO') on one action, joined to pools for the identicon seed,
 * ordered by vote time (newest first, NULL block_time last). SPOs are not power-ranked
 * (we do not store pool stake). Identity (name/ticker/logo) is resolved by the caller
 * via the pools map; this returns the same ActionVoterRow shape as getActionVoters for
 * component reuse, with voting_power null. Default limit 50, capped 200.
 */
export async function getActionSpoVoters(
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
                NULL AS voting_power, p.pool_hash AS hex, v.voter_hex AS voter_hex,
                p.image_stored_url AS image_url, v.block_time AS block_time
         FROM drep_votes v
         LEFT JOIN pools p ON p.pool_id = v.voter_id
         WHERE v.ga_id = ? AND v.voter_role = 'SPO' AND ${liveVoteSql('v')}
         ORDER BY (v.block_time IS NULL), v.block_time DESC, v.voter_id
         LIMIT ? OFFSET ?`,
      )
      .bind(gaId, limit, offset)
      .all<ActionVoterRow>()
  ).results ?? [];
  return rows;
}

/** Count of SPO votes (role 'SPO') on one action. */
export async function countActionSpoVoters(db: D1Database, gaId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM drep_votes WHERE ga_id = ? AND voter_role = 'SPO' AND ${liveVoteSql()}`)
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
): Promise<Map<string, { role: string; vote: string; meta_url: string | null }>> {
  const rows = (
    await db
      .prepare(
        `SELECT voter_id, voter_role, vote, meta_url FROM drep_votes
         WHERE ga_id = ? AND ${liveVoteSql()}`,
      )
      .bind(gaId)
      .all<{ voter_id: string; voter_role: string; vote: string; meta_url: string | null }>()
  ).results ?? [];

  const map = new Map<string, { role: string; vote: string; meta_url: string | null }>();
  for (const r of rows) {
    map.set(r.voter_id, { role: r.voter_role, vote: r.vote, meta_url: r.meta_url ?? null });
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
       FROM drep_votes WHERE voter_id = ? AND voter_role = 'DRep'
         AND ${liveVoteSql()}`,
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
      .prepare(
        `SELECT vote, COUNT(*) AS n FROM drep_votes
         WHERE voter_id = ? AND voter_role = 'DRep' AND ${liveVoteSql()}
         GROUP BY vote`,
      )
      .bind(voterId)
      .all<{ vote: string; n: number }>()
  ).results ?? [];
  const out: DrepVoteBreakdown = { yes: 0, no: 0, abstain: 0, total: 0 };
  for (const r of rows) {
    out[voteBucket(r.vote)] += r.n;
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
            AND ${liveVoteSql('v')}
       WHERE g.decided_epoch IS NOT NULL
         AND g.decided_epoch >= ?
         AND EXISTS (SELECT 1 FROM drep_votes dv WHERE dv.ga_id = g.id AND dv.voter_role = 'DRep'
                       AND ${liveVoteSql('dv')})`,
    )
    .bind(voterId, registeredEpoch)
    .first<{ eligible: number; voted: number }>();
  return { eligible: row?.eligible ?? 0, voted: row?.voted ?? 0 };
}

/**
 * Optimistic local vote written immediately after the wallet submits, before
 * the hourly sync sees it on chain. INSERT OR REPLACE on (ga_id, voter_id) so a
 * re-vote overwrites. local_status='pending' until the authoritative sync
 * replaces the row (clears it) or markStalePendingVotesFailed flags it.
 */
export async function recordLocalVote(
  db: D1Database,
  rec: { gaId: string; drepId: string; voterHex: string | null; vote: string; metaUrl: string | null; txHash: string; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, block_time, synced_at, local_status, tx_hash)
       VALUES (?, 'DRep', ?, ?, ?, ?, NULL, ?, 'pending', ?)`,
    )
    .bind(rec.gaId, rec.drepId, rec.voterHex, rec.vote, rec.metaUrl, rec.now, rec.txHash)
    .run();
}

export interface ViewerVoteRow {
  vote: string;
  local_status: string | null;
  meta_url: string | null;
  tx_hash: string | null;
}

/** The connected DRep's own vote on one action, for the vote panel state. */
export async function getViewerVote(db: D1Database, gaId: string, drepId: string): Promise<ViewerVoteRow | null> {
  const row = await db
    .prepare(
      `SELECT vote, local_status, meta_url, tx_hash FROM drep_votes
       WHERE ga_id = ? AND voter_id = ? AND voter_role = 'DRep'`,
    )
    .bind(gaId, drepId)
    .first<ViewerVoteRow>();
  return row ?? null;
}

/**
 * Removes the optimistic side effects of a vote that never confirmed on chain:
 * the DRep-written ("dreptalk") rationale on the Positions tab and the frozen
 * vote_rationale cross-post in the action's thread (with the topic post_count
 * kept in step). Never touches synced ("onchain") rationales, and only matches
 * posts by a user whose drep_id is the failed voter, so a real vote's artifacts
 * are safe. Idempotent: a second pass over the same failed vote is a no-op.
 */
async function reapFailedVoteArtifacts(db: D1Database, gaId: string, voterId: string): Promise<void> {
  // 1. The optimistic Positions-tab rationale (only the client-written kind).
  await db
    .prepare(`DELETE FROM action_rationale WHERE ga_id = ? AND voter_id = ? AND source = 'dreptalk'`)
    .bind(gaId, voterId)
    .run();

  // 2. The frozen cross-post(s) in the action's discussion, authored by a user
  //    whose drep_id is this voter. Soft-delete and decrement the topic count.
  const posts = (
    await db
      .prepare(
        `SELECT p.id AS id, p.topic_id AS topic_id
         FROM posts p
         JOIN governance_actions g ON g.topic_id = p.topic_id AND g.id = ?
         JOIN users u ON u.id = p.author_id AND u.drep_id = ?
         WHERE p.source = 'vote_rationale' AND p.deleted = 0`,
      )
      .bind(gaId, voterId)
      .all<{ id: string; topic_id: string }>()
  ).results ?? [];
  for (const p of posts) {
    await db.batch([
      db.prepare(`UPDATE posts SET deleted = 1 WHERE id = ?`).bind(p.id),
      db.prepare(`UPDATE topics SET post_count = MAX(post_count - 1, 0) WHERE id = ?`).bind(p.topic_id),
    ]);
  }
}

/**
 * Flags optimistic votes that never appeared on chain. A pending row whose
 * synced_at (submit time, seconds) is older than the cutoff was not replaced by
 * the authoritative sync, so its tx failed or rolled back: mark it 'failed' (kept
 * for the voter's own panel and audit, but hidden from every public vote read)
 * and reap the optimistic rationale + cross-post it left behind. Returns rows changed.
 */
export async function markStalePendingVotesFailed(db: D1Database, cutoffSeconds: number): Promise<number> {
  // Capture which votes will fail before the UPDATE, so their artifacts can be reaped.
  const stale = (
    await db
      .prepare(`SELECT ga_id, voter_id FROM drep_votes WHERE local_status = 'pending' AND synced_at < ?`)
      .bind(cutoffSeconds)
      .all<{ ga_id: string; voter_id: string }>()
  ).results ?? [];
  if (stale.length === 0) return 0;

  await db
    .prepare(`UPDATE drep_votes SET local_status = 'failed' WHERE local_status = 'pending' AND synced_at < ?`)
    .bind(cutoffSeconds)
    .run();

  for (const v of stale) {
    await reapFailedVoteArtifacts(db, v.ga_id, v.voter_id);
  }
  return stale.length;
}

// The functions below are the SPO (pool) equivalents of the DRep stat/history
// functions above, scoped to voter_role = 'SPO'. They are deliberately small
// copies rather than a role parameter on the DRep functions, so the proven
// DRep code paths stay untouched.

/** A pool's on-chain votes (role 'SPO'), joined to the action and its thread. */
export async function getPoolVotingHistory(
  db: D1Database,
  poolId: string,
  opts?: { limit?: number; offset?: number },
): Promise<DrepVoteHistoryRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 500);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const rows = (
    await db
      .prepare(
        `SELECT v.ga_id AS ga_id, v.vote AS vote, g.title AS title, g.type AS type,
                g.status AS status, g.decided_epoch AS decided_epoch,
                g.submitted_epoch AS submitted_epoch, t.slug AS topic_slug,
                v.meta_url AS meta_url, v.block_time AS block_time, r.body_html AS rationale_html
         FROM drep_votes v
         JOIN governance_actions g ON g.id = v.ga_id
         LEFT JOIN topics t ON t.id = g.topic_id
         LEFT JOIN action_rationale r ON r.ga_id = v.ga_id AND r.voter_id = v.voter_id
         WHERE v.voter_id = ? AND v.voter_role = 'SPO' AND ${liveVoteSql('v')}
         ORDER BY (v.block_time IS NULL), v.block_time DESC, g.decided_epoch DESC, g.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(poolId, limit, offset)
      .all<DrepVoteHistoryRow>()
  ).results ?? [];
  return rows;
}

/** Count of a pool's recorded on-chain votes (role 'SPO'). */
export async function countPoolVotes(db: D1Database, poolId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM drep_votes WHERE voter_id = ? AND voter_role = 'SPO' AND ${liveVoteSql()}`)
    .bind(poolId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Yes / No / Abstain counts for a pool (role 'SPO'). */
export async function getPoolVoteBreakdown(db: D1Database, poolId: string): Promise<DrepVoteBreakdown> {
  const rows = (
    await db
      .prepare(`SELECT vote, COUNT(*) AS n FROM drep_votes WHERE voter_id = ? AND voter_role = 'SPO' AND ${liveVoteSql()} GROUP BY vote`)
      .bind(poolId)
      .all<{ vote: string; n: number }>()
  ).results ?? [];
  const out: DrepVoteBreakdown = { yes: 0, no: 0, abstain: 0, total: 0 };
  for (const r of rows) {
    out[voteBucket(r.vote)] += r.n;
    out.total += r.n;
  }
  return out;
}

/** How often a pool attached a rationale anchor to its vote vs not. */
export async function getPoolRationaleStats(db: D1Database, poolId: string): Promise<DrepRationaleStats> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN meta_url IS NULL OR meta_url = '' THEN 1 ELSE 0 END) AS without
       FROM drep_votes WHERE voter_id = ? AND voter_role = 'SPO' AND ${liveVoteSql()}`,
    )
    .bind(poolId)
    .first<{ total: number; without: number }>();
  const total = row?.total ?? 0;
  const without = row?.without ?? 0;
  return { total, without, withRationale: total - without };
}

/**
 * Participation over concluded actions the pool could vote on. Unlike DReps we
 * have no pool registration epoch, so the denominator is every decided action
 * that carries at least one SPO vote (i.e. was SPO-votable), and the numerator
 * is those this pool voted on. Never null: a pool with no eligible actions reads
 * as 0 of 0, which the stats component renders as "no concluded actions yet".
 */
export async function getPoolParticipation(db: D1Database, poolId: string): Promise<DrepParticipation> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS eligible, COUNT(v.ga_id) AS voted
       FROM governance_actions g
       LEFT JOIN drep_votes v ON v.ga_id = g.id AND v.voter_id = ? AND v.voter_role = 'SPO'
            AND ${liveVoteSql('v')}
       WHERE g.decided_epoch IS NOT NULL
         AND EXISTS (SELECT 1 FROM drep_votes dv WHERE dv.ga_id = g.id AND dv.voter_role = 'SPO'
                       AND ${liveVoteSql('dv')})`,
    )
    .bind(poolId)
    .first<{ eligible: number; voted: number }>();
  return { eligible: row?.eligible ?? 0, voted: row?.voted ?? 0 };
}

/** One vote row for the trend chart: role, timing, decision, and decisive power. */
export interface TrendVoteRow {
  voter_role: string;
  voter_id: string;
  block_time: number;
  vote: string;
  voted_power: number | null;
}

/**
 * DRep + SPO votes on one action for the trend chart: only rows with a block_time
 * (the trend needs a timestamp) and not locally failed, ordered oldest first. CC is
 * read separately via getCommitteeVotes (it needs the committee-timeline dedup).
 */
export async function getVoteTrendRows(db: D1Database, gaId: string): Promise<TrendVoteRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT voter_role, voter_id, block_time, vote, voted_power
         FROM drep_votes
         WHERE ga_id = ? AND voter_role IN ('DRep', 'SPO')
           AND block_time IS NOT NULL
           AND ${liveVoteSql()}
         ORDER BY block_time ASC, voter_id`,
      )
      .bind(gaId)
      .all<TrendVoteRow>()
  ).results ?? [];
  return rows;
}
