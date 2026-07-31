/// <reference types="@cloudflare/workers-types" />
// Testable handlers for the proposer-facing co-proposer management UI:
// create an invite link, revoke an active grant, withdraw a pending one.
// Astro routes in src/pages/api/auth/co-proposer/{invite,revoke,withdraw}.ts
// are thin wrappers (same-origin + rate-limit + env wiring) over the three
// functions here, mirroring coProposerRedeem.ts's convention.
//
// Guard shape: requireGrantManager enforces the full "this is a real,
// currently-active proposer managing their OWN grants" condition. Two doors
// must both be shut for an impostor: the session's role set (a grant session
// holds the proposer role too, so !user.grantId is essential) AND the
// underlying row (a member-capped delegator-door session for a real proposer
// must not manage grants either, since that session never proved the
// on-chain proposer identity). Ownership itself (a proposer cannot touch
// another proposer's grants) is enforced by revokeGrant/withdrawInvite's own
// WHERE clauses, not duplicated here.
import { getUserById, type User } from '../db/users.js';
import { createGrantInvite, revokeGrant, withdrawInvite } from '../db/proposerGrants.js';
import { revokeAllForGrant } from './session.js';

export interface HandlerResult {
  status: number;
  json: unknown;
}

/** The subset of locals.user the guard and handlers need. */
export interface GrantManagerUser {
  id: string;
  roles: string[];
  grantId?: string | null;
}

function isHandlerResult(value: { row: User } | HandlerResult): value is HandlerResult {
  return 'status' in value;
}

/**
 * Enforces all of: the session holds the proposer role, the session is NOT
 * itself grant-backed, and the user's own row is an active, on-chain-proven
 * proposer. Returns the loaded row on success. The settings page reuses this
 * exact guard to decide whether to render the management UI at all.
 */
export async function requireGrantManager(
  db: D1Database,
  user: GrantManagerUser,
): Promise<{ row: User } | HandlerResult> {
  if (!user.roles.includes('proposer')) {
    return { status: 403, json: { error: 'forbidden' } };
  }
  if (user.grantId) {
    return { status: 403, json: { error: 'forbidden' } };
  }
  const row = await getUserById(db, user.id);
  if (!row?.is_proposer || row.status !== 'active') {
    return { status: 403, json: { error: 'forbidden' } };
  }
  return { row };
}

// ---------------------------------------------------------------------------
// Create invite
// ---------------------------------------------------------------------------

export interface CreateInviteInput {
  db: D1Database;
  user: GrantManagerUser;
  now?: number;
}

/**
 * Creates a one-time invite link for a new co-proposer. 409s at the
 * per-proposer grant limit (MAX_GRANTS_PER_PROPOSER in proposerGrants.ts).
 */
export async function handleCreateInvite(input: CreateInviteInput): Promise<HandlerResult> {
  try {
    const { db, user, now } = input;
    const guard = await requireGrantManager(db, user);
    if (isHandlerResult(guard)) return guard;

    const invite = await createGrantInvite(db, {
      proposerUserId: user.id,
      proposerStakeAddr: guard.row.stake_addr ?? user.id,
      now,
    });
    if (!invite) {
      return { status: 409, json: { error: 'limit reached' } };
    }
    return {
      status: 200,
      json: { inviteUrl: `/co-proposer/redeem?code=${invite.inviteCode}`, expiresAt: invite.expiresAt },
    };
  } catch {
    // Unexpected internal error: fail closed with a generic 500.
    return { status: 500, json: { error: 'internal error' } };
  }
}

// ---------------------------------------------------------------------------
// Revoke an active grant
// ---------------------------------------------------------------------------

export interface RevokeGrantInput {
  db: D1Database;
  sessionKv: KVNamespace;
  user: GrantManagerUser;
  grantId: string;
  now?: number;
}

/**
 * Revokes an active grant and kills every session it backs. Ownership and
 * the active-only precondition (a pending invite must be withdrawn, not
 * revoked) are both enforced by revokeGrant's WHERE clause; a false there
 * means "not yours, unknown, or not yet active", reported as 404.
 *
 * When revokeGrant flips the row, the KV cleanup is ALWAYS awaited before
 * responding 200. If that cleanup throws (e.g. a transient KV outage), the
 * outer try/catch reports 500 even though D1 already committed. Because
 * revokeGrant is idempotent for a grant this proposer already revoked, the
 * caller simply retries the same request: revokeGrant reports success again
 * without touching D1 a second time, and the KV cleanup gets another chance
 * to finish. This is the only way a partially-failed revoke self-heals.
 */
export async function handleRevokeGrant(input: RevokeGrantInput): Promise<HandlerResult> {
  try {
    const { db, sessionKv, user, grantId, now } = input;
    const guard = await requireGrantManager(db, user);
    if (isHandlerResult(guard)) return guard;

    const ok = await revokeGrant(db, { grantId, proposerUserId: user.id, now });
    if (!ok) {
      return { status: 404, json: { error: 'not found' } };
    }
    await revokeAllForGrant(sessionKv, grantId);
    return { status: 200, json: { ok: true } };
  } catch {
    // Unexpected internal error, possibly after D1 already flipped the grant
    // to revoked; see the doc comment above for why a retry is safe.
    return { status: 500, json: { error: 'internal error' } };
  }
}

// ---------------------------------------------------------------------------
// Withdraw a pending invite
// ---------------------------------------------------------------------------

export interface WithdrawInviteInput {
  db: D1Database;
  user: GrantManagerUser;
  grantId: string;
}

/**
 * Deletes a pending invite that was never redeemed. Ownership and the
 * pending-only precondition are enforced by withdrawInvite's WHERE clause; a
 * false there (unknown id, someone else's grant, or already active/revoked)
 * is reported as 404.
 */
export async function handleWithdrawInvite(input: WithdrawInviteInput): Promise<HandlerResult> {
  try {
    const { db, user, grantId } = input;
    const guard = await requireGrantManager(db, user);
    if (isHandlerResult(guard)) return guard;

    const ok = await withdrawInvite(db, { grantId, proposerUserId: user.id });
    if (!ok) {
      return { status: 404, json: { error: 'not found' } };
    }
    return { status: 200, json: { ok: true } };
  } catch {
    return { status: 500, json: { error: 'internal error' } };
  }
}
