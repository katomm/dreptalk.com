/// <reference types="@cloudflare/workers-types" />
// Testable auth handler functions with injected dependencies.
// Astro routes in src/pages/api/auth/*.ts are thin wrappers over these.

import { issueNonce, consumeNonce } from './nonce.js';
import { verifyCip8 } from './cose.js';
import { isHex, MAX_PAYLOAD_LEN, MAX_KEY_HEX_LEN, MAX_SIG_HEX_LEN } from '../validation/input.js';
import type { ModeratorRole } from '../../../config/moderators.js';
import { drepIdFromPubKey, stakeAddressFromPubKey } from '../cardano/identity.js';
import { resolveDRep, resolveProposer } from './resolveRole.js';
import type { KoiosClient } from './resolveRole.js';
import { upsertUserFromAuth } from '../db/users.js';
import { createSession, revokeSession, buildSessionCookie, clearSessionCookie, parseSessionToken } from './session.js';
import type { CardanoNetwork } from '../config/network.js';

// ---------------------------------------------------------------------------
// Address header bytes
// ---------------------------------------------------------------------------

// CIP-19 reward address header: testnet (preprod) = 0xe0, mainnet = 0xe1.
const REWARD_ADDR_PREPROD = 0xe0;
const REWARD_ADDR_MAINNET = 0xe1;

// CIP-129 DRep key-hash credential header byte = 0x22.
// Pinned from the drep-key-valid fixture:
//   addressHex "22af4e07977b6c2683c065e17ec1ea0421ac7c2fc579f9dd98ff8e2f82"
//   first byte = 0x22 = CIP-129 DRep key-hash on testnet.
// The same header is used on mainnet for key-hash DRep credentials.
const DREP_KEYHASH_HEADER = 0x22;

// ---------------------------------------------------------------------------
// Challenge handler
// ---------------------------------------------------------------------------

export interface ChallengeInput {
  nonceKv: KVNamespace;
  domain: string;
  now?: number;
}

export interface ChallengeResult {
  payload: string;
}

/**
 * Issues a single-use nonce bound to the given domain.
 * Returns the opaque payload the client must sign.
 */
export async function handleChallenge(input: ChallengeInput): Promise<ChallengeResult> {
  const { nonceKv, domain, now } = input;
  const { payload } = await issueNonce(nonceKv, { domain, now });
  return { payload };
}

// ---------------------------------------------------------------------------
// Verify handler
// ---------------------------------------------------------------------------

export interface VerifyBody {
  payload: string;
  signatureHex: string;
  keyHex: string;
  role: string;
}

export interface VerifyInput {
  body: VerifyBody;
  nonceKv: KVNamespace;
  sessionKv: KVNamespace;
  db: D1Database;
  koios: KoiosClient;
  network: CardanoNetwork;
  now?: number;
  secure?: boolean;
}

/** Injected dependencies for handleVerify. All fields are optional; defaults are the real implementations. */
export interface VerifyDeps {
  consumeNonce?: (kv: KVNamespace, payload: string, opts?: { now?: number }) => Promise<boolean>;
  // Resolves a derived stake address to a moderator role, or null when the
  // address is not on the allowlist. Defaults to "no moderators".
  getModeratorRole?: (stakeAddr: string) => ModeratorRole | null;
}

export interface VerifyResult {
  status: number;
  json: unknown;
  setCookie?: string;
}

/**
 * Full CIP-8 verify flow with fail-closed semantics.
 * Returns a structured result (status + json + optional Set-Cookie).
 * Never throws to the caller; all failures are caught and returned as 4xx.
 *
 * The optional second parameter allows injecting a custom consumeNonce
 * implementation for tests. Production callers omit it.
 */
export async function handleVerify(input: VerifyInput, deps?: VerifyDeps): Promise<VerifyResult> {
  try {
    return await handleVerifyInternal(input, deps);
  } catch {
    // Unexpected internal error: fail closed with a generic 500.
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

async function handleVerifyInternal(input: VerifyInput, deps?: VerifyDeps): Promise<VerifyResult> {
  const { body, nonceKv, sessionKv, db, koios, network, now, secure } = input;
  const consumeNonceFn = deps?.consumeNonce ?? consumeNonce;
  const getModeratorRole = deps?.getModeratorRole ?? (() => null);

  // Step 1: Validate body shape.
  if (
    !body ||
    typeof body.payload !== 'string' ||
    typeof body.signatureHex !== 'string' ||
    typeof body.keyHex !== 'string' ||
    typeof body.role !== 'string'
  ) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }
  if (body.role !== 'drep' && body.role !== 'proposer') {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  // Step 1b: Bound and format-check the untrusted fields before any hex decode
  // or crypto. This is a public, unauthenticated endpoint, so reject oversized
  // or non-hex key/signature input cheaply instead of letting it reach the
  // decoder and verifier.
  if (
    body.payload.length > MAX_PAYLOAD_LEN ||
    !isHex(body.keyHex, MAX_KEY_HEX_LEN) ||
    !isHex(body.signatureHex, MAX_SIG_HEX_LEN)
  ) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  // Step 2: Consume nonce (single-use, unexpired).
  const nonceValid = await consumeNonceFn(nonceKv, body.payload, { now });
  if (!nonceValid) {
    return { status: 401, json: { ok: false, error: 'invalid or expired nonce' } };
  }

  // Step 3: Verify CIP-8 signature.
  const verifyResult = await verifyCip8({
    signatureHex: body.signatureHex,
    keyHex: body.keyHex,
    expectedPayload: body.payload,
  });
  if (!verifyResult.ok || !verifyResult.pubKey || !verifyResult.addressBytes) {
    return { status: 401, json: { ok: false, error: 'signature verification failed' } };
  }

  const { pubKey, addressBytes } = verifyResult;

  // Step 4: Header byte validation.
  if (addressBytes.length === 0) {
    return { status: 401, json: { ok: false, error: 'invalid address in signature' } };
  }
  const headerByte = addressBytes[0];

  if (body.role === 'proposer') {
    // Require reward-address header matching the network.
    const expectedHeader = network === 'mainnet' ? REWARD_ADDR_MAINNET : REWARD_ADDR_PREPROD;
    if (headerByte !== expectedHeader) {
      return { status: 401, json: { ok: false, error: 'address type mismatch for role' } };
    }
  } else {
    // role === 'drep': require CIP-129 DRep key-hash header = 0x22.
    if (headerByte !== DREP_KEYHASH_HEADER) {
      return { status: 401, json: { ok: false, error: 'address type mismatch for role' } };
    }
  }

  // Step 5: Derive identity from pubKey.
  let drepId: string | undefined;
  let stakeAddr: string | undefined;

  if (body.role === 'drep') {
    drepId = drepIdFromPubKey(pubKey);
  } else {
    stakeAddr = stakeAddressFromPubKey(pubKey, network);
  }

  // Step 6: Resolve authorization via Koios and the moderator allowlist.
  // Only the roles actually proven on-chain are granted; moderator status comes
  // from the config allowlist (keyed by the derived stake address).
  const grantedRoles: ('drep' | 'proposer')[] = [];
  let modRole: ModeratorRole | null = null;

  if (body.role === 'drep') {
    const resolution = await resolveDRep(koios, drepId!);
    if (!resolution.isDrep) {
      return { status: 401, json: { ok: false, error: 'not an active DRep' } };
    }
    grantedRoles.push('drep');
  } else {
    const resolution = await resolveProposer(koios, stakeAddr!);
    modRole = getModeratorRole(stakeAddr!);
    if (!resolution.isProposer && !modRole) {
      return { status: 401, json: { ok: false, error: 'not a proposer or moderator' } };
    }
    if (resolution.isProposer) grantedRoles.push('proposer');
  }

  // Step 7: Upsert user with the on-chain roles actually granted (a moderator
  // who is neither DRep nor proposer is stored as a plain member row).
  const user = await upsertUserFromAuth(db, {
    drepId,
    stakeAddr,
    roles: grantedRoles,
    now: Math.floor(now ?? Date.now() / 1000),
  });

  // Step 8: Create session. The moderator role is re-evaluated from the
  // allowlist on every login and is not persisted on the user row.
  const roles: string[] = [];
  if (user.is_drep) roles.push('drep');
  if (user.is_proposer) roles.push('proposer');
  if (modRole) roles.push(modRole);
  if (roles.length === 0) roles.push('member');

  const token = await createSession(sessionKv, { id: user.id, roles }, { now });
  const setCookie = buildSessionCookie(token, { secure });

  // Step 9: Return success.
  return {
    status: 200,
    json: { ok: true, user: { id: user.id, roles } },
    setCookie,
  };
}

// ---------------------------------------------------------------------------
// Logout handler
// ---------------------------------------------------------------------------

export interface LogoutInput {
  sessionKv: KVNamespace;
  cookieHeader: string | null;
}

export interface LogoutResult {
  status: number;
  json: unknown;
  setCookie: string;
}

/**
 * Revokes the session from the cookie, returns a cleared cookie.
 * Never throws; silently ignores missing or invalid tokens.
 */
export async function handleLogout(input: LogoutInput): Promise<LogoutResult> {
  const { sessionKv, cookieHeader } = input;
  const token = parseSessionToken(cookieHeader);
  if (token) {
    try {
      await revokeSession(sessionKv, token);
    } catch {
      // Ignore errors: the session is gone either way.
    }
  }
  return {
    status: 200,
    json: { ok: true },
    setCookie: clearSessionCookie(),
  };
}
