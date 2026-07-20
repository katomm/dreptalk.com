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
import { drepIdFromPubKey, stakeAddressFromPubKey, ccHotKeyHashHex, isDrepCredentialAddress } from '../cardano/identity.js';
import { resolveDRep, resolveProposer, resolveSpo, resolveCc, resolveScriptDRep } from './resolveRole.js';
import type { KoiosClient } from './resolveRole.js';
import { upsertUserFromAuth, type AuthRole } from '../db/users.js';
import { createSession, revokeSession, buildSessionCookie, clearSessionCookie, parseSessionToken } from './session.js';
import type { CardanoNetwork } from '../config/network.js';
import { WALLET_NETWORK_MISMATCH } from '../wallet/networkGuard.js';

// ---------------------------------------------------------------------------
// Address header bytes
// ---------------------------------------------------------------------------

// CIP-19 reward address header: testnet (preprod) = 0xe0, mainnet = 0xe1.
const REWARD_ADDR_PREPROD = 0xe0;
const REWARD_ADDR_MAINNET = 0xe1;

// CIP-19 type-6 (enterprise) address header: testnet (preprod) = 0x60, mainnet = 0x61.
const ENTERPRISE_ADDR_PREPROD = 0x60;
const ENTERPRISE_ADDR_MAINNET = 0x61;

// ---------------------------------------------------------------------------
// Challenge handler
// ---------------------------------------------------------------------------

export interface ChallengeInput {
  db: D1Database;
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
  const { db, domain, now } = input;
  const { payload } = await issueNonce(db, { domain, now });
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
  // CIP-129 drep1 id (script credential) the signer claims membership of.
  scriptDrepId?: string;
}

export interface VerifyInput {
  body: VerifyBody;
  sessionKv: KVNamespace;
  db: D1Database;
  koios: KoiosClient;
  network: CardanoNetwork;
  now?: number;
  secure?: boolean;
}

/** Injected dependencies for handleVerify. All fields are optional; defaults are the real implementations. */
export interface VerifyDeps {
  consumeNonce?: (db: D1Database, payload: string, opts?: { now?: number }) => Promise<boolean>;
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
    // A DRep signing offline pastes a raw Ed25519 sig (publicKeyHex), not a COSE
    // key (keyHex): route to the raw verifier. Covers a key-based CLI DRep (no
    // scriptDrepId) and a script-DRep member (with scriptDrepId).
    if (role === 'drep' && typeof body.keyHex !== 'string' && typeof body.publicKeyHex === 'string') {
      return await verifyRawEd25519(role, input, deps);
    }
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
  const { body, db, koios, network, now } = input;
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
  const nonceValid = await consumeNonceFn(db, body.payload, { now });
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

  // Address-form validation. Proposer signs with a reward address; DRep signs
  // with a CIP-95 DRep credential in the COSE address header: a CIP-19 type-6
  // (enterprise) address (0x60 preprod / 0x61 mainnet + key hash) or the bare
  // 28-byte key hash. The identity is bound separately via drepIdFromPubKey.
  if (addressBytes.length === 0) {
    return { status: 401, json: { ok: false, error: 'invalid address in signature' } };
  }

  // Script (multisig) DRep membership: prove the signer holds one of the native
  // script's authorized keys. Identity is the script drep id the client claims.
  if (role === 'drep' && typeof body.scriptDrepId === 'string') {
    if (!isLikelyDrepId(body.scriptDrepId)) {
      return { status: 400, json: { ok: false, error: 'invalid request' } };
    }
    const candidateKeyHashHex = ccHotKeyHashHex(pubKey);
    const resolution = await resolveScriptDRep(koios, body.scriptDrepId, candidateKeyHashHex);
    if (!resolution.isMember) {
      return { status: 401, json: { ok: false, error: scriptMembershipError(resolution.reason) } };
    }
    return finishLogin(input, { drepId: body.scriptDrepId, grantedRoles: ['drep'], modRole: null });
  }

  // A correctly typed address for the OTHER network means the wallet is on the
  // wrong network; report that specifically instead of a role mismatch, so the
  // client can tell the user to switch networks.
  if (role === 'proposer') {
    const expectedHeader = network === 'mainnet' ? REWARD_ADDR_MAINNET : REWARD_ADDR_PREPROD;
    const otherHeader = network === 'mainnet' ? REWARD_ADDR_PREPROD : REWARD_ADDR_MAINNET;
    if (addressBytes[0] === otherHeader) {
      return { status: 401, json: { ok: false, error: WALLET_NETWORK_MISMATCH } };
    }
    if (addressBytes[0] !== expectedHeader) {
      return { status: 401, json: { ok: false, error: 'address type mismatch for role' } };
    }
  } else {
    // role === 'drep'
    if (!isDrepCredentialAddress(addressBytes)) {
      return { status: 401, json: { ok: false, error: 'address type mismatch for role' } };
    }
    // A type-6 header carries the network bit; the bare 28-byte key hash does not.
    const expectedHeader = network === 'mainnet' ? ENTERPRISE_ADDR_MAINNET : ENTERPRISE_ADDR_PREPROD;
    if (addressBytes.length === 29 && addressBytes[0] !== expectedHeader) {
      return { status: 401, json: { ok: false, error: WALLET_NETWORK_MISMATCH } };
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

/** SPO (Calidus) / CC member / script-DRep login: raw Ed25519 signature pasted by the user. */
async function verifyRawEd25519(
  role: 'drep' | 'spo' | 'cc',
  input: VerifyInput,
  deps?: VerifyDeps,
): Promise<VerifyResult> {
  const { body, db, koios, now } = input;
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
  const nonceValid = await consumeNonceFn(db, body.payload, { now });
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

  if (role === 'drep') {
    if (typeof body.scriptDrepId === 'string') {
      // Script (multisig) DRep: prove membership of the native script.
      if (!isLikelyDrepId(body.scriptDrepId)) {
        return { status: 400, json: { ok: false, error: 'invalid request' } };
      }
      const candidateKeyHashHex = ccHotKeyHashHex(pubKey);
      const resolution = await resolveScriptDRep(koios, body.scriptDrepId, candidateKeyHashHex);
      if (!resolution.isMember) {
        return { status: 401, json: { ok: false, error: scriptMembershipError(resolution.reason) } };
      }
      return finishLogin(input, { drepId: body.scriptDrepId, grantedRoles: ['drep'], modRole: null });
    }
    // Key-based CLI DRep signing offline with cardano-signer (no browser wallet):
    // derive the DRep id from the signed key and resolve it on-chain, the same
    // identity binding as the wallet path, just from a raw pubkey instead of COSE.
    const drepId = drepIdFromPubKey(pubKey);
    const resolution = await resolveDRep(koios, drepId);
    if (!resolution.isDrep) {
      return { status: 401, json: { ok: false, error: 'not an active DRep' } };
    }
    return finishLogin(input, { drepId, grantedRoles: ['drep'], modRole: null });
  }

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

  // Cache the user's drep_id on the session so consumers resolve the logged-in
  // DRep without a per-request D1 read (drep_id is immutable for the session).
  const token = await createSession(sessionKv, { id: user.id, roles, drepId: user.drep_id }, { now });
  const setCookie = buildSessionCookie(token, { secure });

  return {
    status: 200,
    json: { ok: true, user: { id: user.id, roles } },
    setCookie,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Cheap shape check for a bech32 drep1 id before any Koios call (bounds + prefix).
function isLikelyDrepId(s: string): boolean {
  return s.length <= 70 && /^drep1[0-9a-z]+$/.test(s);
}

// Distinguishes the script-DRep membership failure modes so the UI can guide the
// user: a key-based DRep that wandered into the script flow, or a Plutus-script
// DRep (no keys to prove membership), instead of one opaque "not a member".
function scriptMembershipError(reason?: string): string {
  if (reason === 'not a script drep' || reason === 'not a script id') return 'key-based drep in script flow';
  if (reason === 'unsupported script') return 'plutus script drep unsupported';
  return 'not a script DRep member';
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
