/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the users table.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.

import { sqlPlaceholders } from './sql.js';

export interface User {
  id: string;
  drep_id: string | null;
  stake_addr: string | null;
  pool_id: string | null;
  cc_cred: string | null;
  is_drep: boolean;
  is_spo: boolean;
  is_cc: boolean;
  is_proposer: boolean;
  role: string;
  status: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  created_at: number;
  last_verified_at: number;
}

// Raw row shape as stored in D1 (booleans as 0/1 integers).
interface UserRow {
  id: string;
  drep_id: string | null;
  stake_addr: string | null;
  pool_id: string | null;
  cc_cred: string | null;
  is_drep: number;
  is_spo: number;
  is_cc: number;
  is_proposer: number;
  role: string;
  status: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  created_at: number;
  last_verified_at: number;
}

/** Maps a raw D1 row to the User type (0/1 integers to JS booleans). */
function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    drep_id: row.drep_id,
    stake_addr: row.stake_addr,
    pool_id: row.pool_id,
    cc_cred: row.cc_cred,
    is_drep: row.is_drep === 1,
    is_spo: row.is_spo === 1,
    is_cc: row.is_cc === 1,
    is_proposer: row.is_proposer === 1,
    role: row.role,
    status: row.status,
    display_name: row.display_name,
    bio: row.bio,
    avatar_url: row.avatar_url,
    created_at: row.created_at,
    last_verified_at: row.last_verified_at,
  };
}

/**
 * Returns the user row for the given id, or null if not found.
 * Uses a single parameterized SELECT.
 */
export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(id)
    .first<UserRow>();
  return row ? rowToUser(row) : null;
}

/**
 * The drep_id of the logged-in DRep, or null when the session isn't a DRep (or the
 * user row is gone). The session `id` isn't always the drep_id (a multi-role user
 * keeps its first-verified credential as id), so the value is read off the user row.
 * Centralizes the lookup the DRep-facing pages share.
 *
 * Sessions minted after drepId-on-session carry drep_id, so the common path returns
 * it with no D1 read. Only legacy sessions predating the field (drepId === undefined)
 * fall back to a single getUserById read; those age out within the 30-day session TTL.
 * Pass Astro.locals.user (or an API route's locals.user) directly.
 */
export async function getSelfDrepId(
  db: D1Database,
  user: { id: string; roles: string[]; drepId?: string | null } | null,
): Promise<string | null> {
  if (!user?.roles.includes('drep')) return null;
  if (user.drepId !== undefined) return user.drepId;
  return (await getUserById(db, user.id))?.drep_id ?? null;
}

/** Returns the user row whose drep_id matches, or null. Uses idx_users_drep_id. */
export async function getUserByDrepId(db: D1Database, drepId: string): Promise<User | null> {
  const row = await db
    .prepare('SELECT * FROM users WHERE drep_id = ? LIMIT 1')
    .bind(drepId)
    .first<UserRow>();
  return row ? rowToUser(row) : null;
}

/** Returns the user row whose pool_id matches, or null. No index on pool_id (small table, one row per user). */
export async function getUserByPoolId(db: D1Database, poolId: string): Promise<User | null> {
  const row = await db
    .prepare('SELECT * FROM users WHERE pool_id = ? LIMIT 1')
    .bind(poolId)
    .first<UserRow>();
  return row ? rowToUser(row) : null;
}

/** Returns the user row whose stake_addr matches, or null. Uses idx_users_stake_addr_unique. */
export async function getUserByStakeAddr(db: D1Database, stakeAddr: string): Promise<User | null> {
  const row = await db
    .prepare('SELECT * FROM users WHERE stake_addr = ? LIMIT 1')
    .bind(stakeAddr)
    .first<UserRow>();
  return row ? rowToUser(row) : null;
}

/**
 * Fetches multiple users by id in a single query (no N+1).
 * Builds a parameterized IN clause from the id list.
 * Returns an empty Map for empty input without querying D1.
 */
export async function getUsersByIds(db: D1Database, ids: string[]): Promise<Map<string, User>> {
  if (ids.length === 0) return new Map();

  const placeholders = sqlPlaceholders(ids);
  const rows = (
    await db
      .prepare(`SELECT * FROM users WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<UserRow>()
  ).results ?? [];

  const result = new Map<string, User>();
  for (const row of rows) {
    result.set(row.id, rowToUser(row));
  }
  return result;
}


/** A writer role proven on-chain at login. */
export type AuthRole = 'drep' | 'proposer' | 'spo' | 'cc';

/**
 * Upserts a user from an auth event.
 *
 * id = drepId ?? stakeAddr ?? poolId ?? ccCred (at least one must be provided);
 * each on-chain credential is its own account in v1 (no cross-credential merge).
 * On INSERT: sets all known fields, created_at and last_verified_at = now.
 *   notif_seen_at also starts at now, so a new account's gov backlog is
 *   marked seen and the badge only reflects activity after this signup.
 * On CONFLICT: updates last_verified_at, ORs in new role flags,
 *   sets the credential strings if not already set (COALESCE).
 *   created_at and notif_seen_at are never overwritten.
 *
 * Returns the resulting row via getUserById.
 */
export async function upsertUserFromAuth(
  db: D1Database,
  args: {
    drepId?: string;
    stakeAddr?: string;
    poolId?: string;
    ccCred?: string;
    roles: AuthRole[];
    now: number;
  },
): Promise<User> {
  const { drepId, stakeAddr, poolId, ccCred, roles, now } = args;
  const id = drepId ?? stakeAddr ?? poolId ?? ccCred;
  if (!id) {
    throw new Error('upsertUserFromAuth: at least one credential (drepId, stakeAddr, poolId, ccCred) must be provided');
  }

  const isDrep = roles.includes('drep') ? 1 : 0;
  const isProposer = roles.includes('proposer') ? 1 : 0;
  const isSpo = roles.includes('spo') ? 1 : 0;
  const isCc = roles.includes('cc') ? 1 : 0;

  // Single INSERT ... ON CONFLICT upsert.
  // On conflict: OR in new role flags, COALESCE to keep existing credential strings,
  // update last_verified_at. created_at is never touched on update.
  await db
    .prepare(
      `INSERT INTO users
         (id, drep_id, stake_addr, pool_id, cc_cred, is_drep, is_proposer, is_spo, is_cc, role, status, created_at, last_verified_at, notif_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'member', 'active', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_verified_at = excluded.last_verified_at,
         is_drep          = is_drep | excluded.is_drep,
         is_proposer      = is_proposer | excluded.is_proposer,
         is_spo           = is_spo | excluded.is_spo,
         is_cc            = is_cc | excluded.is_cc,
         drep_id          = COALESCE(drep_id, excluded.drep_id),
         stake_addr       = COALESCE(stake_addr, excluded.stake_addr),
         pool_id          = COALESCE(pool_id, excluded.pool_id),
         cc_cred          = COALESCE(cc_cred, excluded.cc_cred)`,
    )
    .bind(id, drepId ?? null, stakeAddr ?? null, poolId ?? null, ccCred ?? null, isDrep, isProposer, isSpo, isCc, now, now, now)
    .run();

  const user = await getUserById(db, id);
  if (!user) {
    throw new Error(`upsertUserFromAuth: row not found after upsert for id=${id}`);
  }
  return user;
}
