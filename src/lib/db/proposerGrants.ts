/// <reference types="@cloudflare/workers-types" />
// Co-proposer grants: a proposer invites another stake key via a one-time
// code for one governance action. The redeemed grant lets that key write forum
// posts on the proposer's behalf for that action. Topics and posts persist the
// grant id at write time, so attribution stays historical even after the grant
// is later revoked.
//
// D1 rather than KV for the same reason pairing.ts gives: KV has no
// compare-and-delete, so a get-check-write would let two concurrent requests
// both succeed. The invite limit, the redemption claim, and the revoke flip
// are each a single statement (or a batch SQLite serializes as one unit), so
// each happens at most once.

import { toBase64Url } from '../crypto/base64url.js';
import { bytesToHex } from '../crypto/hex.js';
import { MAX_GRANTS_PER_ACTION } from '../auth/coProposerLimits.js';
import { chunked, D1_MAX_BINDS, sqlPlaceholders } from './sql.js';

/** How long a pending invite code stays redeemable before it is swept. */
export const GRANT_INVITE_TTL_SEC = 604800;

export interface ProposerGrant {
  id: string;
  proposer_user_id: string;
  proposer_stake_addr: string;
  gov_action_id: string;
  team_label: string | null;
  co_user_id: string | null;
  co_stake_addr: string | null;
  status: 'pending' | 'active' | 'revoked';
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
  revoked_at: number | null;
}

// Columns making up ProposerGrant, in interface order. Excludes
// invite_code_hash, which is never returned to a caller.
const GRANT_COLUMNS =
  'id, proposer_user_id, proposer_stake_addr, gov_action_id, team_label, co_user_id, co_stake_addr, status, created_at, expires_at, redeemed_at, revoked_at';

/**
 * Predicate every grant read filters on: rows from before the per-action
 * rebuild have no gov_action_id and stay invisible, which is why the type
 * keeps the column non-null. Prefix it with a table alias in joined queries
 * (`pg.${GRANT_HAS_ACTION}`).
 */
export const GRANT_HAS_ACTION = 'gov_action_id IS NOT NULL';

/** A grant plus the topic of its governance action (null when the action has no thread or no row). */
export type GrantWithTopic = ProposerGrant & { topic_id: string | null };

/** SHA-256 of a UTF-8 string as lowercase hex, same helper shape as pairing.ts. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** 32 bytes of randomness as base64url, same shape as the pairing device secret. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Creates a pending invite for one governance action and returns the plain
 * code, the only time it is ever emitted, only its hash is persisted. Returns
 * null when the action already holds MAX_GRANTS_PER_ACTION
 * active-or-unexpired-pending grants. The caller has validated teamLabel.
 *
 * Expired pending rows and rows without a gov_action_id (written by the code
 * that predates per-action grants) are swept in the same batch, so the table
 * stays small without a cron, and freed slots count immediately: the INSERT's
 * own SELECT re-counts inside the same serialized statement, so two concurrent
 * creates can never both pass the limit check.
 */
export async function createGrantInvite(
  db: D1Database,
  args: {
    proposerUserId: string;
    proposerStakeAddr: string;
    govActionId: string;
    teamLabel: string | null;
    now?: number;
  },
): Promise<{ grantId: string; inviteCode: string; expiresAt: number } | null> {
  const now = Math.floor(args.now ?? Date.now() / 1000);
  const grantId = crypto.randomUUID();
  const inviteCode = randomToken();
  const codeHash = await sha256Hex(inviteCode);
  const expiresAt = now + GRANT_INVITE_TTL_SEC;

  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM proposer_grants
          WHERE gov_action_id IS NULL OR (status = 'pending' AND expires_at <= ?1)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO proposer_grants
           (id, proposer_user_id, proposer_stake_addr, gov_action_id, team_label, invite_code_hash, status, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?7, ?8, ?4, 'pending', ?5, ?6
         WHERE (SELECT COUNT(*) FROM proposer_grants
                 WHERE gov_action_id = ?7
                   AND (status = 'active' OR (status = 'pending' AND expires_at > ?5)))
               < ${MAX_GRANTS_PER_ACTION}`,
      )
      .bind(
        grantId,
        args.proposerUserId,
        args.proposerStakeAddr,
        codeHash,
        now,
        expiresAt,
        args.govActionId,
        args.teamLabel,
      ),
  ]);
  if ((results[1]?.meta?.changes ?? 0) === 0) return null;
  return { grantId, inviteCode, expiresAt };
}

/**
 * Reads a pending, unexpired invite by its plain code without changing it.
 * Returns null for unknown, redeemed and expired codes alike.
 */
export async function lookupInviteByCode(
  db: D1Database,
  rawCode: string,
  opts?: { now?: number },
): Promise<{
  grantId: string;
  proposerStakeAddr: string;
  govActionId: string;
  teamLabel: string | null;
} | null> {
  const now = Math.floor(opts?.now ?? Date.now() / 1000);
  const codeHash = await sha256Hex(rawCode);
  const row = await db
    .prepare(
      `SELECT id, proposer_stake_addr, gov_action_id, team_label FROM proposer_grants
        WHERE invite_code_hash = ?1 AND status = 'pending' AND expires_at > ?2
          AND ${GRANT_HAS_ACTION}`,
    )
    .bind(codeHash, now)
    .first<{ id: string; proposer_stake_addr: string; gov_action_id: string; team_label: string | null }>();
  return row === null
    ? null
    : {
        grantId: row.id,
        proposerStakeAddr: row.proposer_stake_addr,
        govActionId: row.gov_action_id,
        teamLabel: row.team_label,
      };
}

/**
 * Redeems a pending invite: activates the grant and stamps the co-proposer's
 * identity. Rejects a self-invite (the proposer redeeming their own code)
 * before the claim, and again as a defense in the claim's WHERE clause so a
 * raced state can never activate it. On success, also fills the co-user's
 * display_name if it is still empty; an existing name is never overwritten.
 */
export async function redeemGrant(
  db: D1Database,
  args: { grantId: string; coUserId: string; coStakeAddr: string; displayName: string; now?: number },
): Promise<
  | { ok: true; proposerUserId: string; proposerStakeAddr: string }
  | { ok: false; reason: 'unavailable' | 'mandate_taken' | 'self' }
> {
  const now = Math.floor(args.now ?? Date.now() / 1000);
  const self = await db
    .prepare(`SELECT 1 FROM proposer_grants WHERE id = ?1 AND proposer_stake_addr = ?2`)
    .bind(args.grantId, args.coStakeAddr)
    .first();
  if (self) return { ok: false, reason: 'self' };

  try {
    const results = await db.batch([
      // Single-winner claim, same RETURNING pattern as pairing.ts.
      db
        .prepare(
          `UPDATE proposer_grants
              SET status = 'active', co_user_id = ?1, co_stake_addr = ?2, redeemed_at = ?3
            WHERE id = ?4 AND status = 'pending' AND expires_at > ?3
              AND ${GRANT_HAS_ACTION}
              AND proposer_stake_addr <> ?2
            RETURNING proposer_user_id, proposer_stake_addr`,
        )
        .bind(args.coUserId, args.coStakeAddr, now, args.grantId),
      // Name fills only an empty slot and only when the claim above won; an
      // existing display_name is never overwritten by the invite form.
      db
        .prepare(
          `UPDATE users SET display_name = ?1
            WHERE id = ?2 AND (display_name IS NULL OR display_name = '')
              AND EXISTS (SELECT 1 FROM proposer_grants
                           WHERE id = ?3 AND status = 'active' AND co_user_id = ?2)`,
        )
        .bind(args.displayName, args.coUserId, args.grantId),
    ]);
    const row = results[0]?.results?.[0] as
      | { proposer_user_id: string; proposer_stake_addr: string }
      | undefined;
    if (!row) return { ok: false, reason: 'unavailable' };
    return { ok: true, proposerUserId: row.proposer_user_id, proposerStakeAddr: row.proposer_stake_addr };
  } catch (err) {
    // The partial unique index on active (co_stake_addr, gov_action_id) aborts
    // the whole batch when this stake key already holds a mandate for the
    // action. The pending invite is then useless, so drop it.
    if (String(err).includes('UNIQUE')) {
      await db
        .prepare(`DELETE FROM proposer_grants WHERE id = ?1 AND status = 'pending'`)
        .bind(args.grantId)
        .run();
      return { ok: false, reason: 'mandate_taken' };
    }
    throw err;
  }
}

/** Active grants a co-proposer holds, one per governance action, oldest first. */
export async function listActiveGrantsForCoUser(db: D1Database, coUserId: string): Promise<ProposerGrant[]> {
  const { results } = await db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM proposer_grants
        WHERE co_user_id = ?1 AND status = 'active' AND ${GRANT_HAS_ACTION}
        ORDER BY redeemed_at ASC, id ASC`,
    )
    .bind(coUserId)
    .all<ProposerGrant>();
  return results ?? [];
}

/** True when the user holds at least one active grant. */
export async function hasActiveGrantForCoUser(db: D1Database, coUserId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM proposer_grants
        WHERE co_user_id = ?1 AND status = 'active' AND ${GRANT_HAS_ACTION} LIMIT 1`,
    )
    .bind(coUserId)
    .first();
  return row !== null;
}

/**
 * The id of the user's active grant for the governance action whose thread is
 * `topicId`, or null. One query from topic to grant, oldest grant first should
 * more than one ever match.
 */
export async function getActiveGrantIdForTopic(
  db: D1Database,
  coUserId: string,
  topicId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT pg.id FROM governance_actions ga
         JOIN proposer_grants pg ON pg.gov_action_id = ga.id
        WHERE ga.topic_id = ?1 AND pg.co_user_id = ?2 AND pg.status = 'active'
        ORDER BY pg.redeemed_at ASC, pg.id ASC
        LIMIT 1`,
    )
    .bind(topicId, coUserId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * The write-path hard gate: true only when the grant is active and belongs
 * to this user. Callers must not infer authorization from any other read.
 */
export async function isGrantActiveForUser(db: D1Database, grantId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM proposer_grants
        WHERE id = ?1 AND co_user_id = ?2 AND status = 'active' AND ${GRANT_HAS_ACTION}`,
    )
    .bind(grantId, userId)
    .first();
  return row !== null;
}

/**
 * Active plus unexpired pending grants for a proposer, grouped by governance
 * action. Within an action the newest grant comes first.
 */
export async function getGrantsForProposerActions(
  db: D1Database,
  proposerUserId: string,
  opts?: { now?: number },
): Promise<Map<string, ProposerGrant[]>> {
  const now = Math.floor(opts?.now ?? Date.now() / 1000);
  const { results } = await db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM proposer_grants
        WHERE proposer_user_id = ?1 AND ${GRANT_HAS_ACTION}
          AND (status = 'active' OR (status = 'pending' AND expires_at > ?2))
        ORDER BY created_at DESC`,
    )
    .bind(proposerUserId, now)
    .all<ProposerGrant>();
  const out = new Map<string, ProposerGrant[]>();
  for (const row of results ?? []) {
    const list = out.get(row.gov_action_id);
    if (list) list.push(row);
    else out.set(row.gov_action_id, [row]);
  }
  return out;
}

/**
 * Fetches multiple grants by id, each with the topic of its governance action,
 * one query per D1_MAX_BINDS ids (no N+1). Returns an empty Map for empty
 * input without querying D1.
 */
export async function getGrantsByIds(db: D1Database, ids: readonly string[]): Promise<Map<string, GrantWithTopic>> {
  const out = new Map<string, GrantWithTopic>();
  const cols = GRANT_COLUMNS.split(', ').map((c) => `pg.${c}`).join(', ');
  for (const chunk of chunked(ids, D1_MAX_BINDS)) {
    const { results } = await db
      .prepare(
        `SELECT ${cols}, ga.topic_id
           FROM proposer_grants pg
           LEFT JOIN governance_actions ga ON ga.id = pg.gov_action_id
          WHERE pg.${GRANT_HAS_ACTION} AND pg.id IN (${sqlPlaceholders(chunk)})`,
      )
      .bind(...chunk)
      .all<GrantWithTopic>();
    for (const row of results ?? []) out.set(row.id, row);
  }
  return out;
}

/**
 * Revokes a grant. Idempotent: returns true both for the active-to-revoked
 * flip this call performs AND for a grant this proposer already revoked
 * earlier, so a retrying caller can always tell revocation succeeded. Returns
 * false for an unknown id, a grant owned by a different proposer, or a grant
 * that is still pending (never activated).
 */
export async function revokeGrant(
  db: D1Database,
  args: { grantId: string; proposerUserId: string; now?: number },
): Promise<boolean> {
  const now = Math.floor(args.now ?? Date.now() / 1000);
  // Flip if still active; then report success for any revoked grant this
  // proposer owns, whether this call or an earlier one did the flip.
  await db
    .prepare(
      `UPDATE proposer_grants SET status = 'revoked', revoked_at = ?1
        WHERE id = ?2 AND proposer_user_id = ?3 AND status = 'active'`,
    )
    .bind(now, args.grantId, args.proposerUserId)
    .run();
  const row = await db
    .prepare(`SELECT 1 FROM proposer_grants WHERE id = ?1 AND proposer_user_id = ?2 AND status = 'revoked'`)
    .bind(args.grantId, args.proposerUserId)
    .first();
  return row !== null;
}

/** Deletes a pending invite that was never redeemed. Never touches an active or revoked grant. */
export async function withdrawInvite(
  db: D1Database,
  args: { grantId: string; proposerUserId: string },
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM proposer_grants WHERE id = ?1 AND proposer_user_id = ?2 AND status = 'pending'`)
    .bind(args.grantId, args.proposerUserId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
