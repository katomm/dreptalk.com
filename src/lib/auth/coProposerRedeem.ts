/// <reference types="@cloudflare/workers-types" />
// Testable handlers for co-proposer invite redemption: a logged-out holder of
// an invite link proves their wallet with a CIP-8 signature and becomes an
// active co-proposer with a grant-backed session. Astro routes in
// src/pages/api/auth/co-proposer/*.ts are thin wrappers (rate-limit + env
// wiring) over the two functions here, mirroring handlers.ts's convention.
//
// Security shape: the client holds only the invite CODE, never a grantId. Both
// handlers resolve the code to a grantId server-side via lookupInviteByCode and
// bind that resolved id into the nonce domain (grantRedeemDomain). A caller
// that supplied a grantId directly (bypassing the code) could otherwise probe
// or race redemption of a grant it was never handed the invite link for;
// possession of the link is what gates redemption, not knowledge of the id.
import { consumeNonceForDomain, issueNonce } from './nonce.js';
import { verifyCip8 } from './cose.js';
import { checkRewardAddressHeader } from './handlers.js';
import { resolveDelegatorAccount } from './delegatorLogin.js';
import { lookupInviteByCode, redeemGrant } from '../db/proposerGrants.js';
import { createSession, buildSessionCookie } from './session.js';
import { rolesFromUser, normalizeSessionRoles } from './roles.js';
import { isHex, sanitizeExternalText, MAX_PAYLOAD_LEN, MAX_KEY_HEX_LEN, MAX_SIG_HEX_LEN } from '../validation/input.js';
import type { CardanoNetwork } from '../config/network.js';
// Re-exported from a client-safe module so the redeem island can import the
// limit without dragging this server-only module into the client bundle.
import { MAX_CO_PROPOSER_NAME } from './coProposerLimits.js';

export { MAX_CO_PROPOSER_NAME };

// Invite codes are randomToken() output (32 raw bytes as base64url, ~43
// chars); the cap is generous headroom, not a tight fit to the real length.
const MAX_CODE_LEN = 64;
const CODE_RE = /^[A-Za-z0-9_-]+$/;

function isValidCode(code: unknown): code is string {
  return typeof code === 'string' && code.length > 0 && code.length <= MAX_CODE_LEN && CODE_RE.test(code);
}

/** Nonce domain a redemption proof must be signed under, bound to the resolved grant. */
export function grantRedeemDomain(grantId: string): string {
  return `proposer_grant_redeem:${grantId}`;
}

// ---------------------------------------------------------------------------
// Challenge handler
// ---------------------------------------------------------------------------

export interface RedeemChallengeInput {
  db: D1Database;
  code: string;
  now?: number;
}

export interface RedeemChallengeResult {
  status: number;
  json: unknown;
}

/**
 * Resolves an invite code to its grant and issues a single-use nonce bound to
 * that grant. Returns 404 for any code that does not resolve to a pending,
 * unexpired invite (unknown, already redeemed, or expired all look alike to
 * the caller, so a probing attacker learns nothing about which case applied).
 */
export async function handleRedeemChallenge(input: RedeemChallengeInput): Promise<RedeemChallengeResult> {
  try {
    const { db, code, now } = input;
    if (!isValidCode(code)) {
      return { status: 404, json: { ok: false, error: 'invite unavailable' } };
    }
    const invite = await lookupInviteByCode(db, code, { now });
    if (!invite) {
      return { status: 404, json: { ok: false, error: 'invite unavailable' } };
    }
    const { payload } = await issueNonce(db, { domain: grantRedeemDomain(invite.grantId), now });
    return { status: 200, json: { payload } };
  } catch {
    // Unexpected internal error: fail closed with a generic 500.
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

// ---------------------------------------------------------------------------
// Redeem handler
// ---------------------------------------------------------------------------

export interface RedeemGrantBody {
  code: string;
  payload: string;
  signatureHex: string;
  keyHex: string;
  displayName: string;
}

export interface RedeemGrantInput {
  body: RedeemGrantBody;
  sessionKv: KVNamespace;
  db: D1Database;
  network: CardanoNetwork;
  now?: number;
  secure?: boolean;
}

/** Injected dependencies for handleRedeemGrant. All fields optional; defaults are the real implementations. */
export interface RedeemGrantDeps {
  consumeNonceForDomain?: (
    db: D1Database,
    payload: string,
    expectedDomain: string,
    opts?: { now?: number; maxAgeSec?: number },
  ) => Promise<boolean>;
}

export interface RedeemGrantResult {
  status: number;
  json: unknown;
  setCookie?: string;
}

/**
 * Full invite-redemption flow with fail-closed semantics (flow mirrors
 * handleVerify in handlers.ts). Returns a structured result (status + json +
 * optional Set-Cookie). Never throws to the caller; all failures are caught
 * and returned as a 4xx/5xx result.
 *
 * Validation order matters and is exercised by the test suite: body
 * shape/bounds first (400, before any nonce consumption), then the code
 * lookup (410), then the nonce consume (401), then the CIP-8 verify (401),
 * then the reward-address header check (401), and only then the account
 * resolve and the atomic grant claim.
 */
export async function handleRedeemGrant(input: RedeemGrantInput, deps?: RedeemGrantDeps): Promise<RedeemGrantResult> {
  try {
    return await handleRedeemGrantInternal(input, deps);
  } catch {
    // Unexpected internal error (including a session-mint failure after the
    // grant claim already committed): fail closed with a generic 500. The
    // grant itself stays active; recovering the stranded session is the
    // proposer-login fallback's job (out of scope here).
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

async function handleRedeemGrantInternal(input: RedeemGrantInput, deps?: RedeemGrantDeps): Promise<RedeemGrantResult> {
  const { body, db, sessionKv, network, now, secure } = input;
  const consumeFn = deps?.consumeNonceForDomain ?? consumeNonceForDomain;
  const nowSec = Math.floor(now ?? Date.now() / 1000);

  // Step 1: validate body shape/bounds before any nonce consumption or D1 lookup.
  if (
    !body ||
    typeof body.code !== 'string' ||
    !isValidCode(body.code) ||
    typeof body.payload !== 'string' ||
    body.payload.length > MAX_PAYLOAD_LEN ||
    typeof body.signatureHex !== 'string' ||
    !isHex(body.signatureHex, MAX_SIG_HEX_LEN) ||
    typeof body.keyHex !== 'string' ||
    !isHex(body.keyHex, MAX_KEY_HEX_LEN) ||
    typeof body.displayName !== 'string'
  ) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }
  // Bound the raw trimmed length before sanitizing, so an overlong name is
  // rejected outright rather than silently truncated.
  const trimmedName = body.displayName.trim();
  if (trimmedName.length === 0 || trimmedName.length > MAX_CO_PROPOSER_NAME) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }
  const displayName = sanitizeExternalText(trimmedName, MAX_CO_PROPOSER_NAME);
  if (displayName.length === 0) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  // Step 1b: resolve the code server-side. The caller never supplies a
  // grantId directly; possession of the code is what proves it holds the link.
  const invite = await lookupInviteByCode(db, body.code, { now: nowSec });
  if (!invite) {
    return { status: 410, json: { ok: false, error: 'invite unavailable' } };
  }

  // Step 2: single-use nonce, bound to this exact resolved grant.
  const nonceValid = await consumeFn(db, body.payload, grantRedeemDomain(invite.grantId), { now: nowSec });
  if (!nonceValid) {
    return { status: 401, json: { ok: false, error: 'invalid or expired nonce' } };
  }

  // Step 3: verify the CIP-8 signature over the exact nonce payload.
  const verifyResult = await verifyCip8({
    signatureHex: body.signatureHex,
    keyHex: body.keyHex,
    expectedPayload: body.payload,
  });
  if (!verifyResult.ok || !verifyResult.pubKey || !verifyResult.addressBytes) {
    return { status: 401, json: { ok: false, error: 'signature verification failed' } };
  }

  // Step 4: reward-address header + network check, the same rule the
  // proposer/delegator login path applies to this exact kind of signature.
  const check = checkRewardAddressHeader(verifyResult.addressBytes, verifyResult.pubKey, network);
  if (!check.ok) {
    return { status: 401, json: { ok: false, error: check.error } };
  }
  const stakeAddr = check.stakeAddr;

  // Step 5: account routing, identical to delegator login: reuse an existing
  // account that already owns this stake address, else create a member row.
  const user = await resolveDelegatorAccount(db, stakeAddr, nowSec);

  // Step 6: atomic claim. The D1 partial unique index (one active mandate per
  // co stake key) and the proposer_stake_addr <> co_stake_addr guard are the
  // real enforcement; redeemGrant just reports which case applied.
  const res = await redeemGrant(db, {
    grantId: invite.grantId,
    coUserId: user.id,
    coStakeAddr: stakeAddr,
    displayName,
    now: nowSec,
  });
  if (!res.ok) {
    if (res.reason === 'mandate_taken') {
      return { status: 409, json: { ok: false, error: 'mandate_taken' } };
    }
    if (res.reason === 'self') {
      return { status: 400, json: { ok: false, error: 'cannot invite yourself' } };
    }
    return { status: 410, json: { ok: false, error: 'invite unavailable' } };
  }

  // Step 7: session roles are the account's own on-chain roles (minus the
  // bare member fallback) plus proposer, granted for the duration of the grant.
  const base = rolesFromUser(user, null).filter((r) => r !== 'member');
  const roles = normalizeSessionRoles([...base, 'proposer']);

  // Step 8: mint the grant-backed session and return it. If this throws, the
  // outer catch reports 500; the grant claim above already committed, so it
  // stays active for the login fallback to recover later (task 4, out of scope here).
  const token = await createSession(
    sessionKv,
    {
      id: user.id,
      roles,
      drepId: user.drep_id,
      grantId: invite.grantId,
      actsFor: { userId: res.proposerUserId, stakeAddr: res.proposerStakeAddr },
    },
    { now: nowSec },
  );

  return {
    status: 200,
    json: { ok: true, user: { id: user.id, roles } },
    setCookie: buildSessionCookie(token, { secure }),
  };
}
