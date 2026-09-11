/// <reference types="@cloudflare/workers-types" />
// Every D1 read the window pack needs, one statement per function. The pack
// composer (pack.ts) does the grouping and the arithmetic, this file only
// fetches rows, so the SQL of a figure can be checked without reading the
// composition around it. Id lists are chunked well under D1's 100-bind cap.
import { chunked, sqlPlaceholders } from '../db/sql.js';
import { SPECIAL_DREP_IDS } from '../dreps/special.js';

/** Ids per statement. Below D1's 100-bind cap with room for the fixed binds. */
const ID_CHUNK = 90;

export interface ActionDbRow {
  id: string; type: string; title: string; status: string;
  submitted_epoch: number | null; ratified_epoch: number | null; enacted_epoch: number | null; decided_epoch: number | null; expiry_epoch: number | null;
  onchain_payload: string | null;
  drep_yes: number; drep_no: number; drep_abstain: number; drep_yes_pct: number | null; drep_no_pct: number | null;
  drep_yes_power: string | null; drep_no_power: string | null; drep_abstain_power: string | null;
  spo_yes: number; spo_no: number; spo_abstain: number; spo_yes_pct: number | null; spo_no_pct: number | null;
  spo_yes_power: number | null; spo_no_side_power: string | null; spo_eligible_power: number | null; tally_epoch: number | null;
  cc_yes: number; cc_no: number; cc_abstain: number; cc_yes_pct: number | null;
  thresholds_json: string | null;
}

const ACTION_COLUMNS = `id, type, title, status, submitted_epoch, ratified_epoch, enacted_epoch, decided_epoch, expiry_epoch, onchain_payload,
  drep_yes, drep_no, drep_abstain, drep_yes_pct, drep_no_pct, drep_yes_power, drep_no_power, drep_abstain_power,
  spo_yes, spo_no, spo_abstain, spo_yes_pct, spo_no_pct, spo_yes_power, spo_no_side_power, spo_eligible_power, tally_epoch,
  cc_yes, cc_no, cc_abstain, cc_yes_pct, thresholds_json`;

/**
 * Every action whose lifecycle could overlap the window: submitted at or before
 * its end, and either still running or with a ratification, enactment or
 * terminal epoch at or after its start. Deliberately wider than the window, the
 * composer classifies by lifecycle epochs, so an action that only expired later
 * still has to arrive here to be reported as open during the window.
 */
export async function readWindowActions(db: D1Database, from: number, to: number): Promise<ActionDbRow[]> {
  const res = await db
    .prepare(
      `SELECT ${ACTION_COLUMNS} FROM governance_actions
        WHERE submitted_epoch <= ?
          AND (decided_epoch IS NULL OR decided_epoch >= ? OR enacted_epoch >= ? OR ratified_epoch >= ?)
        ORDER BY submitted_epoch ASC, id ASC`,
    )
    .bind(to, from, from, from)
    .all<ActionDbRow>();
  return res.results ?? [];
}

/**
 * Earlier actions of the given types, for comparison with what the window
 * decided. Strictly before the window's first epoch, so a comparison can never
 * cite something that had not happened yet.
 */
export async function readEarlierActionsOfTypes(db: D1Database, types: string[], from: number): Promise<ActionDbRow[]> {
  if (types.length === 0) return [];
  const res = await db
    .prepare(
      `SELECT ${ACTION_COLUMNS} FROM governance_actions
        WHERE type IN (${sqlPlaceholders(types)}) AND submitted_epoch < ?
        ORDER BY submitted_epoch DESC, id ASC`,
    )
    .bind(...types, from)
    .all<ActionDbRow>();
  return res.results ?? [];
}

export interface VoteRow {
  ga_id: string;
  voter_role: string;
  voter_id: string;
  voter_hex: string | null;
  vote: string;
  block_time: number | null;
}

/** Final (non-superseded) votes cast inside the half-open unix range. */
export async function readVotesInRange(db: D1Database, startUnix: number, endUnix: number): Promise<VoteRow[]> {
  const res = await db
    .prepare(
      `SELECT ga_id, voter_role, voter_id, voter_hex, vote, block_time FROM drep_votes
        WHERE block_time >= ? AND block_time < ?`,
    )
    .bind(startUnix, endUnix)
    .all<VoteRow>();
  return res.results ?? [];
}

/** Superseded votes cast inside the same range. A re-vote is a second vote row. */
export async function readVoteHistoryInRange(db: D1Database, startUnix: number, endUnix: number): Promise<VoteRow[]> {
  const res = await db
    .prepare(
      `SELECT ga_id, voter_role, voter_id, NULL AS voter_hex, vote, block_time FROM drep_vote_history
        WHERE block_time >= ? AND block_time < ?`,
    )
    .bind(startUnix, endUnix)
    .all<VoteRow>();
  return res.results ?? [];
}

/**
 * Final votes on the given actions, cast at or before the window's end. The
 * window is the reference for the whole pack, so a ballot cast after it must
 * not appear in the focus sections (voteTimeline, topVoters, spo, ccVotes,
 * topDreps.ballots) as if it stood at that point. A null block_time (a vote
 * synced before the column existed, or ahead of the backfill) cannot be placed
 * on either side of the boundary, so it is kept rather than silently dropped.
 */
export async function readVotesForActions(db: D1Database, ids: string[], endUnix: number): Promise<VoteRow[]> {
  const out: VoteRow[] = [];
  for (const batch of chunked(ids, ID_CHUNK)) {
    const res = await db
      .prepare(
        `SELECT ga_id, voter_role, voter_id, voter_hex, vote, block_time FROM drep_votes
          WHERE ga_id IN (${sqlPlaceholders(batch)}) AND (block_time IS NULL OR block_time < ?)`,
      )
      .bind(...batch, endUnix)
      .all<VoteRow>();
    out.push(...(res.results ?? []));
  }
  return out;
}

/** Superseded votes on the given actions cast at or before the window's end, so a timeline shows the re-vote too. */
export async function readVoteHistoryForActions(db: D1Database, ids: string[], endUnix: number): Promise<VoteRow[]> {
  const out: VoteRow[] = [];
  for (const batch of chunked(ids, ID_CHUNK)) {
    const res = await db
      .prepare(
        `SELECT ga_id, voter_role, voter_id, NULL AS voter_hex, vote, block_time FROM drep_vote_history
          WHERE ga_id IN (${sqlPlaceholders(batch)}) AND (block_time IS NULL OR block_time < ?)`,
      )
      .bind(...batch, endUnix)
      .all<VoteRow>();
    out.push(...(res.results ?? []));
  }
  return out;
}

/** Oldest and newest epoch the rolling power history still holds, null when empty. */
export async function readPowerCoverage(db: D1Database): Promise<{ from: number; to: number } | null> {
  const row = await db
    .prepare('SELECT MIN(epoch) AS lo, MAX(epoch) AS hi FROM drep_voting_power_history')
    .first<{ lo: number | null; hi: number | null }>();
  if (row?.lo == null || row.hi == null) return null;
  return { from: row.lo, to: row.hi };
}

export interface PowerRow { drep_id: string; epoch: number; amount: string }

/** Historical power of the given DReps over an epoch range. Never sync-time power. */
export async function readPowerForDreps(db: D1Database, epochFrom: number, epochTo: number, drepIds: string[]): Promise<PowerRow[]> {
  const out: PowerRow[] = [];
  for (const batch of chunked(drepIds, ID_CHUNK)) {
    const res = await db
      .prepare(
        `SELECT drep_id, epoch, amount FROM drep_voting_power_history
          WHERE epoch BETWEEN ? AND ? AND drep_id IN (${sqlPlaceholders(batch)})`,
      )
      .bind(epochFrom, epochTo, ...batch)
      .all<PowerRow>();
    out.push(...(res.results ?? []));
  }
  return out;
}

const SPECIAL_PLACEHOLDERS = sqlPlaceholders(SPECIAL_DREP_IDS);

/** The largest non-special DReps by historical power at one epoch. */
export async function readTopDrepsAtEpoch(db: D1Database, epoch: number, limit: number): Promise<Array<{ drep_id: string; amount: string; name: string | null }>> {
  const res = await db
    .prepare(
      `SELECT h.drep_id, h.amount, d.name FROM drep_voting_power_history h
         LEFT JOIN dreps d ON d.drep_id = h.drep_id
        WHERE h.epoch = ? AND h.drep_id NOT IN (${SPECIAL_PLACEHOLDERS})
        ORDER BY CAST(h.amount AS INTEGER) DESC LIMIT ?`,
    )
    .bind(epoch, ...SPECIAL_DREP_IDS, limit)
    .all<{ drep_id: string; amount: string; name: string | null }>();
  return res.results ?? [];
}

/**
 * The steepest power losses between two epochs. Specials are excluded, the
 * two-layer convention of the analytics contract: the predefined options are
 * the default delegation layer, not DReps whose power moved. A DRep with no
 * row at toEpoch (the power-history sync skips null amounts, so a DRep who
 * deregistered between the two epochs simply has no snapshot) is a drop to
 * zero, not an absent row, so the second history table is left joined and the
 * missing side coalesced to zero rather than filtering the row out entirely.
 */
export async function readPowerDrops(db: D1Database, fromEpoch: number, toEpoch: number, limit: number): Promise<Array<{ drep_id: string; name: string | null; status: string | null; from_amount: string; to_amount: string }>> {
  const res = await db
    .prepare(
      `SELECT a.drep_id, d.name, d.status, a.amount AS from_amount, COALESCE(b.amount, '0') AS to_amount
         FROM drep_voting_power_history a
         LEFT JOIN drep_voting_power_history b ON b.drep_id = a.drep_id AND b.epoch = ?
         LEFT JOIN dreps d ON d.drep_id = a.drep_id
        WHERE a.epoch = ? AND a.drep_id NOT IN (${SPECIAL_PLACEHOLDERS})
        ORDER BY (CAST(a.amount AS INTEGER) - CAST(COALESCE(b.amount, '0') AS INTEGER)) DESC LIMIT ?`,
    )
    .bind(toEpoch, fromEpoch, ...SPECIAL_DREP_IDS, limit)
    .all<{ drep_id: string; name: string | null; status: string | null; from_amount: string; to_amount: string }>();
  return res.results ?? [];
}

/** Display names of the given DReps. */
export async function readDrepNames(db: D1Database, drepIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const batch of chunked(drepIds, ID_CHUNK)) {
    const res = await db
      .prepare(`SELECT drep_id, name FROM dreps WHERE drep_id IN (${sqlPlaceholders(batch)})`)
      .bind(...batch)
      .all<{ drep_id: string; name: string | null }>();
    for (const r of res.results ?? []) out.set(r.drep_id, r.name);
  }
  return out;
}

/**
 * The committee minimum size in force at `epoch`: the newest stored parameter
 * snapshot at or before it. Returns null when nothing was stored that early,
 * so a historical window never borrows today's value.
 */
export async function readCommitteeMinSizeAt(db: D1Database, epoch: number): Promise<{ value: number | null; observedAtEpoch: number; reason?: string } | null> {
  const row = await db
    .prepare(
      `SELECT committee_min_size, epoch FROM protocol_params
        WHERE epoch IS NOT NULL AND epoch <= ? ORDER BY epoch DESC LIMIT 1`,
    )
    .bind(epoch)
    .first<{ committee_min_size: number | null; epoch: number }>();
  if (!row) return null;
  // A snapshot exists but never recorded the minimum. That is a different fact
  // from having no snapshot at all, and an edition has to be able to say which.
  if (row.committee_min_size == null) {
    return { value: null, observedAtEpoch: row.epoch, reason: `snapshot at epoch ${row.epoch} has no committee minimum` };
  }
  return { value: row.committee_min_size, observedAtEpoch: row.epoch };
}

/** Treasury withdrawals enacted at or before `epoch`. Later ones never exist for a historical window. */
export async function readEnactedWithdrawals(db: D1Database, epoch: number): Promise<Array<{ id: string; title: string | null; enacted_epoch: number; onchain_payload: string | null }>> {
  const res = await db
    .prepare(
      `SELECT id, title, enacted_epoch, onchain_payload FROM governance_actions
        WHERE type = 'TreasuryWithdrawals' AND status = 'enacted' AND enacted_epoch IS NOT NULL AND enacted_epoch <= ?
        ORDER BY enacted_epoch ASC, id ASC`,
    )
    .bind(epoch)
    .all<{ id: string; title: string | null; enacted_epoch: number; onchain_payload: string | null }>();
  return res.results ?? [];
}
