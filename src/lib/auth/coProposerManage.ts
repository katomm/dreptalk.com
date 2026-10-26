/// <reference types="@cloudflare/workers-types" />
// Testable handlers for the proposer-facing co-proposer management UI:
// create an invite link, revoke an active grant, withdraw a pending one.
// Astro routes in src/pages/api/auth/co-proposer/{invite,revoke,withdraw}.ts
// are thin wrappers (same-origin + rate-limit + env wiring) over the three
// functions here, mirroring coProposerRedeem.ts's convention.
//
// Guard shape: requireGrantManager enforces the full "this is a real,
// currently-active proposer managing their OWN grants" condition. Two doors
// must both be shut for an impostor: the session's role set (a co-proposer
// session holds the co-proposer role, never proposer) AND the underlying row (a member-capped delegator-door session for a real proposer
// must not manage grants either, since that session never proved the
// on-chain proposer identity). Ownership itself (a proposer cannot touch
// another proposer's grants) is enforced by revokeGrant/withdrawInvite's own
// WHERE clauses, not duplicated here.
import { getUserById, type User } from '../db/users.js';
import { parseAuthors } from '../db/governance.js';
import { isTerminalStatus } from '../governance/view.js';
import { createGrantInvite, revokeGrant, withdrawInvite } from '../db/proposerGrants.js';

// `<tx hash>#<index>`, the governance_actions.id form (never gov_action1...).
const GOV_ACTION_ID_RE = /^[0-9a-f]{64}#\d{1,5}$/i;

export interface HandlerResult {
  status: number;
  json: unknown;
}

/** The subset of locals.user the guard and handlers need. */
export interface GrantManagerUser {
  id: string;
  roles: string[];
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
  /** Governance action the invite is for (`<tx hash>#<index>`). */
  govActionId?: unknown;
  /** Optional team name, must be one of the action's CIP-108 authors. Absent, empty or blank means none. */
  teamLabel?: unknown;
  now?: number;
}

/**
 * Creates a one-time invite link for a new co-proposer. 409s at the
 * per-action grant limit (MAX_GRANTS_PER_ACTION in coProposerLimits.ts).
 */
export async function handleCreateInvite(input: CreateInviteInput): Promise<HandlerResult> {
  try {
    const { db, user, now } = input;
    const guard = await requireGrantManager(db, user);
    if (isHandlerResult(guard)) return guard;

    // Proposer stake address is required to guard against self-invites in
    // redeemGrant's WHERE clause. Fail closed if missing.
    if (!guard.row.stake_addr) {
      return { status: 500, json: { error: 'internal error' } };
    }

    const govActionId = input.govActionId;
    if (typeof govActionId !== 'string' || !GOV_ACTION_ID_RE.test(govActionId)) {
      return { status: 400, json: { error: 'invalid action' } };
    }

    // An unknown action and someone else's action look alike (403), so the
    // endpoint does not reveal which ids exist.
    const action = await db
      .prepare('SELECT status, return_address, topic_id, authors FROM governance_actions WHERE id = ?1')
      .bind(govActionId)
      .first<{ status: string; return_address: string | null; topic_id: string | null; authors: string | null }>();
    if (!action || action.return_address !== guard.row.stake_addr) {
      return { status: 403, json: { error: 'forbidden' } };
    }
    if (isTerminalStatus(action.status)) {
      return { status: 409, json: { error: 'action finished' } };
    }
    if (!action.topic_id) {
      return { status: 409, json: { error: 'no thread yet' } };
    }

    let teamLabel: string | null = null;
    if (input.teamLabel !== undefined && input.teamLabel !== null) {
      const picked = typeof input.teamLabel === 'string' ? input.teamLabel.trim() : null;
      if (picked === null || (picked !== '' && !(parseAuthors(action.authors) ?? []).includes(picked))) {
        return { status: 400, json: { error: 'unknown team' } };
      }
      teamLabel = picked === '' ? null : picked;
    }

    const invite = await createGrantInvite(db, {
      proposerUserId: user.id,
      proposerStakeAddr: guard.row.stake_addr,
      govActionId,
      teamLabel,
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
  user: GrantManagerUser;
  grantId: string;
  now?: number;
}

/**
 * Revokes an active grant. Sessions are not pinned to grants, every write
 * re-checks the grant in D1, so there is nothing to clean up in KV. Ownership and
 * the active-only precondition (a pending invite must be withdrawn, not
 * revoked) are both enforced by revokeGrant's WHERE clause; a false there
 * means "not yours, unknown, or not yet active", reported as 404.
 */
export async function handleRevokeGrant(input: RevokeGrantInput): Promise<HandlerResult> {
  try {
    const { db, user, grantId, now } = input;
    const guard = await requireGrantManager(db, user);
    if (isHandlerResult(guard)) return guard;

    const ok = await revokeGrant(db, { grantId, proposerUserId: user.id, now });
    if (!ok) {
      return { status: 404, json: { error: 'not found' } };
    }
    return { status: 200, json: { ok: true } };
  } catch {
    // Unexpected internal error: fail closed with a generic 500.
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
