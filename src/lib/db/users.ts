/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the users table.
// All queries use .prepare().bind() exclusively; never string-concatenated SQL.

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
 * Fetches multiple users by id in a single query (no N+1).
 * Builds a parameterized IN clause from the id list.
 * Returns an empty Map for empty input without querying D1.
 */
export async function getUsersByIds(db: D1Database, ids: string[]): Promise<Map<string, User>> {
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => '?').join(', ');
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

/**
 * Upserts a user from an auth event.
 *
 * id = drepId ?? stakeAddr (at least one must be provided).
 * On INSERT: sets all known fields, created_at and last_verified_at = now.
 * On CONFLICT: updates last_verified_at, ORs in new role flags,
 *   sets drep_id/stake_addr if not already set (COALESCE).
 *   created_at is never overwritten.
 *
 * Returns the resulting row via getUserById.
 */
export async function upsertUserFromAuth(
  db: D1Database,
  args: {
    drepId?: string;
    stakeAddr?: string;
    roles: ('drep' | 'proposer')[];
    now: number;
  },
): Promise<User> {
  const { drepId, stakeAddr, roles, now } = args;
  const id = drepId ?? stakeAddr;
  if (!id) {
    throw new Error('upsertUserFromAuth: either drepId or stakeAddr must be provided');
  }

  const isDrep = roles.includes('drep') ? 1 : 0;
  const isProposer = roles.includes('proposer') ? 1 : 0;

  // Single INSERT ... ON CONFLICT upsert.
  // On conflict: OR in new role flags, COALESCE to keep existing credential strings,
  // update last_verified_at. created_at is never touched on update.
  await db
    .prepare(
      `INSERT INTO users
         (id, drep_id, stake_addr, is_drep, is_proposer, role, status, created_at, last_verified_at)
       VALUES (?, ?, ?, ?, ?, 'member', 'active', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_verified_at = excluded.last_verified_at,
         is_drep          = is_drep | excluded.is_drep,
         is_proposer      = is_proposer | excluded.is_proposer,
         drep_id          = COALESCE(drep_id, excluded.drep_id),
         stake_addr       = COALESCE(stake_addr, excluded.stake_addr)`,
    )
    .bind(id, drepId ?? null, stakeAddr ?? null, isDrep, isProposer, now, now)
    .run();

  const user = await getUserById(db, id);
  if (!user) {
    throw new Error(`upsertUserFromAuth: row not found after upsert for id=${id}`);
  }
  return user;
}
