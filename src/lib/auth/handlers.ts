/// <reference types="@cloudflare/workers-types" />
// Testable auth handler functions with injected dependencies.
// Astro routes in src/pages/api/auth/*.ts are thin wrappers over these.

import { issueNonce, consumeNonce } from './nonce.js';
import { verifyCip8 } from './cose.js';
import { verifyEd25519 } from '../crypto/ed25519.js';
import { hexToBytes } from '../crypto/hex.js';
import {
  isHex,
  isHexExact,
  MAX_PAYLOAD_LEN,
  MAX_KEY_HEX_LEN,
  MAX_SIG_HEX_LEN,
  RAW_SIG_HEX_LEN,
  RAW_PUBKEY_HEX_LEN,
} from '../validation/input.js';
import type { ModeratorRole } from '../../../config/moderators.js';
import { drepIdFromPubKey, stakeAddressFromPubKey, ccHotKeyHashHex } from '../cardano/identity.js';
import { resolveDRep, resolveProposer, resolveSpo, resolveCc } from './resolveRole.js';
import type { KoiosClient } from './resolveRole.js';
import { upsertUserFromAuth, type AuthRole } from '../db/users.js';
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
  // COSE_Key, present for the CIP-8 wallet flow (drep / proposer).
  keyHex?: string;
  // Raw 32-byte Ed25519 public key (hex), present for the paste flow (spo / cc).
  publicKeyHex?: string;
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
  const { body } = input;

  // Step 1: Validate the fields common to both flows.
  if (
    !body ||
    typeof body.payload !== 'string' ||
    typeof body.signatureHex !== 'string' ||
    typeof body.role !== 'string'
  ) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }
  const role = body.role;
  if (role !== 'drep' && role !== 'proposer' && role !== 'spo' && role !== 'cc') {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }
  if (body.payload.length > MAX_PAYLOAD_LEN) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  // DRep and Proposer prove identity with a CIP-8 wallet signature; SPO (Calidus)
  // and CC members paste a raw Ed25519 signature produced by cardano-signer.
  if (role === 'drep' || role === 'proposer') {
    return await verifyWalletCip8(role, input, deps);
  }
  return await verifyRawEd25519(role, input, deps);
}

/** DRep / Proposer login: CIP-8 COSE signature from a CIP-30 wallet. */
async function verifyWalletCip8(
  role: 'drep' | 'proposer',
  input: VerifyInput,
  deps?: VerifyDeps,
): Promise<VerifyResult> {
  const { body, nonceKv, koios, network, now } = input;
  const consumeNonceFn = deps?.consumeNonce ?? consumeNonce;
  const getModeratorRole = deps?.getModeratorRole ?? (() => null);

  // Bound and format-check the untrusted fields before any hex decode or crypto.
  if (
    typeof body.keyHex !== 'string' ||
    !isHex(body.keyHex, MAX_KEY_HEX_LEN) ||
    !isHex(body.signatureHex, MAX_SIG_HEX_LEN)
  ) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  // Consume nonce (single-use, unexpired).
  const nonceValid = await consumeNonceFn(nonceKv, body.payload, { now });
  if (!nonceValid) {
    return { status: 401, json: { ok: false, error: 'invalid or expired nonce' } };
  }

  // Verify CIP-8 signature.
  const verifyResult = await verifyCip8({
    signatureHex: body.signatureHex,
    keyHex: body.keyHex,
    expectedPayload: body.payload,
  });
  if (!verifyResult.ok || !verifyResult.pubKey || !verifyResult.addressBytes) {
    return { status: 401, json: { ok: false, error: 'signature verification failed' } };
  }

  const { pubKey, addressBytes } = verifyResult;

  // Header byte validation.
  if (addressBytes.length === 0) {
    return { status: 401, json: { ok: false, error: 'invalid address in signature' } };
  }
  const headerByte = addressBytes[0];

  if (role === 'proposer') {
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

  // Derive identity from the verified pubKey, then resolve authorization via
  // Koios and (for the stake-key path) the moderator allowlist.
  const grantedRoles: AuthRole[] = [];
  let modRole: ModeratorRole | null = null;
  let drepId: string | undefined;
  let stakeAddr: string | undefined;

  if (role === 'drep') {
    drepId = drepIdFromPubKey(pubKey);
    const resolution = await resolveDRep(koios, drepId);
    if (!resolution.isDrep) {
      return { status: 401, json: { ok: false, error: 'not an active DRep' } };
    }
    grantedRoles.push('drep');
  } else {
    stakeAddr = stakeAddressFromPubKey(pubKey, network);
    const resolution = await resolveProposer(koios, stakeAddr);
    modRole = getModeratorRole(stakeAddr);
    if (!resolution.isProposer && !modRole) {
      return { status: 401, json: { ok: false, error: 'not a proposer or moderator' } };
    }
    if (resolution.isProposer) grantedRoles.push('proposer');
  }

  return finishLogin(input, { drepId, stakeAddr, grantedRoles, modRole });
}

/** SPO (Calidus) / CC member login: raw Ed25519 signature pasted by the user. */
async function verifyRawEd25519(
  role: 'spo' | 'cc',
  input: VerifyInput,
  deps?: VerifyDeps,
): Promise<VerifyResult> {
  const { body, nonceKv, koios, now } = input;
  const consumeNonceFn = deps?.consumeNonce ?? consumeNonce;

  // Raw Ed25519: signature is exactly 64 bytes, public key exactly 32 bytes.
  if (
    typeof body.publicKeyHex !== 'string' ||
    !isHexExact(body.signatureHex, RAW_SIG_HEX_LEN) ||
    !isHexExact(body.publicKeyHex, RAW_PUBKEY_HEX_LEN)
  ) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  // Consume nonce (single-use, unexpired).
  const nonceValid = await consumeNonceFn(nonceKv, body.payload, { now });
  if (!nonceValid) {
    return { status: 401, json: { ok: false, error: 'invalid or expired nonce' } };
  }

  // Verify the detached signature over the exact nonce payload. Identity is
  // derived only from the verified public key, never claimed by the client.
  const pubKey = hexToBytes(body.publicKeyHex);
  const sig = hexToBytes(body.signatureHex);
  const msg = new TextEncoder().encode(body.payload);
  const sigResult = await verifyEd25519(sig, msg, pubKey);
  if (!sigResult.ok) {
    return { status: 401, json: { ok: false, error: 'signature verification failed' } };
  }

  const grantedRoles: AuthRole[] = [];
  let poolId: string | undefined;
  let ccCred: string | undefined;

  if (role === 'spo') {
    const resolution = await resolveSpo(koios, body.publicKeyHex.toLowerCase());
    if (!resolution.isSpo) {
      return { status: 401, json: { ok: false, error: 'not an active SPO' } };
    }
    grantedRoles.push('spo');
    poolId = resolution.poolId;
  } else {
    const hotKeyHashHex = ccHotKeyHashHex(pubKey);
    const resolution = await resolveCc(koios, hotKeyHashHex);
    if (!resolution.isCc) {
      return { status: 401, json: { ok: false, error: 'not an authorized CC member' } };
    }
    grantedRoles.push('cc');
    // Account identity is the stable cold credential where available; fall back
    // to the hot credential the member signed with.
    ccCred = resolution.ccColdId ?? resolution.ccHotId;
  }

  return finishLogin(input, { poolId, ccCred, grantedRoles, modRole: null });
}

/**
 * Shared login tail: upsert the user with the credentials and on-chain roles
 * proven this login, then mint a session. The moderator role is re-evaluated
 * from the allowlist on every login and is not persisted on the user row.
 */
async function finishLogin(
  input: VerifyInput,
  args: {
    drepId?: string;
    stakeAddr?: string;
    poolId?: string;
    ccCred?: string;
    grantedRoles: AuthRole[];
    modRole: ModeratorRole | null;
  },
): Promise<VerifyResult> {
  const { db, sessionKv, now, secure } = input;
  const { drepId, stakeAddr, poolId, ccCred, grantedRoles, modRole } = args;

  const user = await upsertUserFromAuth(db, {
    drepId,
    stakeAddr,
    poolId,
    ccCred,
    roles: grantedRoles,
    now: Math.floor(now ?? Date.now() / 1000),
  });

  const roles: string[] = [];
  if (user.is_drep) roles.push('drep');
  if (user.is_proposer) roles.push('proposer');
  if (user.is_spo) roles.push('spo');
  if (user.is_cc) roles.push('cc');
  if (modRole) roles.push(modRole);
  if (roles.length === 0) roles.push('member');

  const token = await createSession(sessionKv, { id: user.id, roles }, { now });
  const setCookie = buildSessionCookie(token, { secure });

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
