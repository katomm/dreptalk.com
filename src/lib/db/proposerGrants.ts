/// <reference types="@cloudflare/workers-types" />
// Co-proposer grants: a proposer invites another stake key via a one-time
// code; the redeemed grant lets that key write forum posts on the proposer's
// behalf. Topics and posts persist the grant id at write time, so
// attribution stays historical even after the grant is later revoked.
//
// D1 rather than KV for the same reason pairing.ts gives: KV has no
// compare-and-delete, so a get-check-write would let two concurrent requests
// both succeed. The invite limit, the redemption claim, and the revoke flip
// are each a single statement (or a batch SQLite serializes as one unit), so
// each happens at most once.

import { toBase64Url } from '../crypto/base64url.js';
import { bytesToHex } from '../crypto/hex.js';
import { sqlPlaceholders } from './sql.js';

/** How long a pending invite code stays redeemable before it is swept. */
export const GRANT_INVITE_TTL_SEC = 604800;

/** Active plus unexpired-pending grants a single proposer may hold at once. */
export const MAX_GRANTS_PER_PROPOSER = 2;

export interface ProposerGrant {
  id: string;
  proposer_user_id: string;
  proposer_stake_addr: string;
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
  'id, proposer_user_id, proposer_stake_addr, co_user_id, co_stake_addr, status, created_at, expires_at, redeemed_at, revoked_at';

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
 * Creates a pending invite for a proposer and returns the plain code, the
 * only time it is ever emitted; only its hash is persisted. Returns null when
 * the proposer already holds MAX_GRANTS_PER_PROPOSER active-or-unexpired-pending
 * grants.
 *
 * Expired pending rows are swept in the same batch, so the table stays small
 * without a cron, and freed slots count immediately: the INSERT's own SELECT
 * re-counts inside the same serialized statement, so two concurrent creates
 * can never both pass the limit check.
 */
export async function createGrantInvite(
  db: D1Database,
  args: { proposerUserId: string; proposerStakeAddr: string; now?: number },
): Promise<{ grantId: string; inviteCode: string; expiresAt: number } | null> {
  const now = Math.floor(args.now ?? Date.now() / 1000);
  const grantId = crypto.randomUUID();
  const inviteCode = randomToken();
  const codeHash = await sha256Hex(inviteCode);
  const expiresAt = now + GRANT_INVITE_TTL_SEC;

  const results = await db.batch([
    db.prepare(`DELETE FROM proposer_grants WHERE status = 'pending' AND expires_at <= ?1`).bind(now),
    db
      .prepare(
        `INSERT INTO proposer_grants
           (id, proposer_user_id, proposer_stake_addr, invite_code_hash, status, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6
         WHERE (SELECT COUNT(*) FROM proposer_grants
                 WHERE proposer_user_id = ?2
                   AND (status = 'active' OR (status = 'pending' AND expires_at > ?5)))
               < ${MAX_GRANTS_PER_PROPOSER}`,
      )
      .bind(grantId, args.proposerUserId, args.proposerStakeAddr, codeHash, now, expiresAt),
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
): Promise<{ grantId: string; proposerStakeAddr: string } | null> {
  const now = Math.floor(opts?.now ?? Date.now() / 1000);
  const codeHash = await sha256Hex(rawCode);
  const row = await db
    .prepare(
      `SELECT id, proposer_stake_addr FROM proposer_grants
        WHERE invite_code_hash = ?1 AND status = 'pending' AND expires_at > ?2`,
    )
    .bind(codeHash, now)
    .first<{ id: string; proposer_stake_addr: string }>();
  return row === null ? null : { grantId: row.id, proposerStakeAddr: row.proposer_stake_addr };
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
    // The partial unique index on active co_stake_addr aborts the whole batch
    // when this stake key already holds a mandate.
    if (String(err).includes('UNIQUE')) return { ok: false, reason: 'mandate_taken' };
    throw err;
  }
}

/** Returns the active grant for a stake key, or null if it holds none. */
export async function getActiveGrantByCoStake(db: D1Database, coStakeAddr: string): Promise<ProposerGrant | null> {
  return db
    .prepare(`SELECT ${GRANT_COLUMNS} FROM proposer_grants WHERE co_stake_addr = ?1 AND status = 'active'`)
    .bind(coStakeAddr)
    .first<ProposerGrant>();
}

/**
 * The write-path hard gate: true only when the grant is active and belongs
 * to this user. Callers must not infer authorization from any other read.
 */
export async function isGrantActiveForUser(db: D1Database, grantId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM proposer_grants WHERE id = ?1 AND co_user_id = ?2 AND status = 'active'`)
    .bind(grantId, userId)
    .first();
  return row !== null;
}

/** Active plus unexpired pending grants for a proposer, newest first. */
export async function getGrantsForProposer(
  db: D1Database,
  proposerUserId: string,
  opts?: { now?: number },
): Promise<ProposerGrant[]> {
  const now = Math.floor(opts?.now ?? Date.now() / 1000);
  const { results } = await db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM proposer_grants
        WHERE proposer_user_id = ?1
          AND (status = 'active' OR (status = 'pending' AND expires_at > ?2))
        ORDER BY created_at DESC`,
    )
    .bind(proposerUserId, now)
    .all<ProposerGrant>();
  return results ?? [];
}

/**
 * Fetches multiple grants by id in a single query (no N+1), chunked under the
 * D1 bind-param limit. Returns an empty Map for empty input without querying D1.
 */
export async function getGrantsByIds(db: D1Database, ids: readonly string[]): Promise<Map<string, ProposerGrant>> {
  const out = new Map<string, ProposerGrant>();
  if (ids.length === 0) return out;

  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(`SELECT ${GRANT_COLUMNS} FROM proposer_grants WHERE id IN (${sqlPlaceholders(chunk)})`)
      .bind(...chunk)
      .all<ProposerGrant>();
    for (const row of results ?? []) out.set(row.id, row);
  }
  return out;
}

/**
 * Revokes a grant. Idempotent: returns true both for the active-to-revoked
 * flip this call performs AND for a grant this proposer already revoked
 * earlier, so a caller retrying a failed KV cleanup step can always tell
 * revocation succeeded. Returns false for an unknown id, a grant owned by a
 * different proposer, or a grant that is still pending (never activated).
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
