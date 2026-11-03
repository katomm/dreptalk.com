/// <reference types="@cloudflare/workers-types" />
// Group signer login: a key DRep whose registration is retired or inactive can still sign in
// with the narrow group-signer role while its key sits in a policy of an active DRep group.
import type { EventRef } from 'drep-groups';
import { parseDrepId } from '../cardano/identity.js';
import { hashBytes, refFromCols } from '../groups/codec.js';
import { Q } from '../groups/store/queries.js';
import { GROUP_SIGNER_ROLE } from './roles.js';
import type { DRepResolution } from './resolveRole.js';

export { GROUP_SIGNER_ROLE };

/**
 * The key hash a session signs group actions with: a key DRep's credential hash for a drep
 * session and for a group signer session. Script DRep sessions and every other session give null.
 */
export function sessionKeyHash(user: App.Locals['user']): string | null {
  if (!user?.drepId) return null;
  if (!user.roles.includes('drep') && !user.roles.includes(GROUP_SIGNER_ROLE)) return null;
  const parsed = parseDrepId(user.drepId);
  return parsed?.kind === 'key' ? parsed.hashHex : null;
}

/** The active groups that have the key in their control or admission policy. */
export async function groupsForPolicyKey(db: D1Database, keyHash: string): Promise<EventRef[]> {
  const { results } = await db.prepare(Q.groupsForPolicyKey.sql).bind(hashBytes(keyHash)).all<Record<string, unknown>>();
  return results.map((r) => refFromCols(r.group_tx, r.group_ix));
}

/**
 * True when a key DRep that failed the on-chain check may sign in as a group signer: it is
 * retired or inactive (any other rejection stays) and its key is in an active group's policy.
 */
export async function isGroupSigner(db: D1Database, resolution: DRepResolution, keyHash: string): Promise<boolean> {
  if (resolution.reason !== 'not registered' && resolution.reason !== 'inactive') return false;
  return (await groupsForPolicyKey(db, keyHash)).length > 0;
}
