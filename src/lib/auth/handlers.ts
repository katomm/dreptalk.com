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
import { upsertUserFromAuth, type AuthRole, type User } from '../db/users.js';
import { createSession, revokeSession, buildSessionCookie, clearSessionCookie, parseSessionToken } from './session.js';
import { sessionActivityHook } from './sessionActivity.js';
import { rolesFromUser, normalizeSessionRoles } from './roles.js';
import type { CardanoNetwork } from '../config/network.js';
import { WALLET_NETWORK_MISMATCH } from '../wallet/networkGuard.js';
import { resolveDelegatorAccount } from './delegatorLogin.js';
import { ensureFollow } from '../db/delegatorFollows.js';
import { resolveFollow } from '../delegation/refresh.js';
import { getActiveGrantByCoStake } from '../db/proposerGrants.js';

// ---------------------------------------------------------------------------
// Address header bytes
// ---------------------------------------------------------------------------

// CIP-19 reward address header: testnet (preprod) = 0xe0, mainnet = 0xe1.
const REWARD_ADDR_PREPROD = 0xe0;
const REWARD_ADDR_MAINNET = 0xe1;

// CIP-19 type-6 (enterprise) address header: testnet (preprod) = 0x60, mainnet = 0x61.
const ENTERPRISE_ADDR_PREPROD = 0x60;
const ENTERPRISE_ADDR_MAINNET = 0x61;

export interface RewardAddressCheckOk {
  ok: true;
  stakeAddr: string;
}
export interface RewardAddressCheckErr {
  ok: false;
  error: string;
}

/**
 * Confirms `addressBytes` (the COSE-signed address recovered from an already
 * verified CIP-8 signature) is a reward address for `network`, then derives
 * the stake address from `pubKey`. Shared by the proposer/delegator
 * wallet-login path below and the writer stake-link flow (linkStake.ts):
 * both prove control of a stake wallet with the same reward-address CIP-8
 * signature and must apply the identical network/type check before trusting
 * the derived stake address.
 *
 * A correctly typed address for the OTHER network is reported as a network
 * mismatch specifically (not a generic type mismatch), so the client can tell
 * the user to switch networks instead of showing a confusing role error.
 */
export function checkRewardAddressHeader(
  addressBytes: Uint8Array,
  pubKey: Uint8Array,
  network: CardanoNetwork,
): RewardAddressCheckOk | RewardAddressCheckErr {
  if (addressBytes.length === 0) {
    return { ok: false, error: 'invalid address in signature' };
  }
  const expectedHeader = network === 'mainnet' ? REWARD_ADDR_MAINNET : REWARD_ADDR_PREPROD;
  const otherHeader = network === 'mainnet' ? REWARD_ADDR_PREPROD : REWARD_ADDR_MAINNET;
  if (addressBytes[0] === otherHeader) {
    return { ok: false, error: WALLET_NETWORK_MISMATCH };
  }
  if (addressBytes[0] !== expectedHeader) {
    return { ok: false, error: 'address type mismatch for role' };
  }
  return { ok: true, stakeAddr: stakeAddressFromPubKey(pubKey, network) };
}

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
  // Cloudflare execution context, when the adapter exposes one. Lets the
  // delegator login defer the delegation resolve past the response (zero
  // added login latency) instead of resolving it inline.
  ctx?: { waitUntil(p: Promise<unknown>): void };
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
  if (role !== 'drep' && role !== 'proposer' && role !== 'spo' && role !== 'cc' && role !== 'delegator') {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }
  if (body.payload.length > MAX_PAYLOAD_LEN) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  // DRep and Proposer prove identity with a CIP-8 wallet signature; SPO (Calidus)
  // and CC members paste a raw Ed25519 signature produced by cardano-signer.
  // Delegator proves wallet ownership only (no on-chain role), the same
  // reward-address CIP-8 signature a proposer signs, so it takes the wallet path.
  if (role === 'drep' || role === 'proposer' || role === 'delegator') {
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

/** DRep / Proposer / Delegator login: CIP-8 COSE signature from a CIP-30 wallet. */
async function verifyWalletCip8(
  role: 'drep' | 'proposer' | 'delegator',
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
  if (role === 'proposer' || role === 'delegator') {
    const check = checkRewardAddressHeader(addressBytes, pubKey, network);
    if (!check.ok) {
      return { status: 401, json: { ok: false, error: check.error } };
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

  // Delegator proves wallet ownership only: no Koios lookup, no on-chain role,
  // routed through the shared account resolver so a later delegator sign-in
  // reuses an account that already owns this stake address (e.g. a writer who
  // linked the same wallet) instead of minting a duplicate.
  if (role === 'delegator') {
    const stakeAddr = stakeAddressFromPubKey(pubKey, network);
    const verifiedAt = Math.floor(now ?? Date.now() / 1000);
    const user = await resolveDelegatorAccount(db, stakeAddr, verifiedAt);
    // The tracking row exists synchronously; a stake-addr mismatch throws here
    // (internal inconsistency, surfaced as a 500), not fail-soft.
    await ensureFollow(db, user.id, stakeAddr, verifiedAt);
    // Decision A: the delegator door always mints a member-capped session and
    // never a drepId, regardless of the routed account's roles. Writer rights
    // require the writer door, which revalidates on-chain.
    const result = mintSessionResult(input, user, null, { roles: ['member'], drepId: null });
    // Resolve after minting: deferred via waitUntil when the runtime exposes it
    // (zero added login latency), else inline with the short-bounded fail-soft
    // resolver. Either way the login never fails on Koios.
    const doResolve = () => resolveFollow(db, koios, user.id, stakeAddr, verifiedAt);
    if (input.ctx?.waitUntil) input.ctx.waitUntil(doResolve());
    else await doResolve();
    return result;
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
    if (!resolution.isProposer) {
      // Not an on-chain proposer: an active co-proposer grant still opens the
      // proposer door, with the mandate pinned to the session. The user row
      // keeps is_proposer = 0; the role exists only while the grant does.
      const grant = await getActiveGrantByCoStake(db, stakeAddr);
      if (grant) {
        const verifiedAt = Math.floor(now ?? Date.now() / 1000);
        const user = await resolveDelegatorAccount(db, stakeAddr, verifiedAt);
        const base = rolesFromUser(user, modRole).filter((r) => r !== 'member');
        const roles = normalizeSessionRoles([...base, 'proposer']);
        return mintSessionResult(input, user, null, {
          roles,
          drepId: user.drep_id,
          grantId: grant.id,
          actsFor: { userId: grant.proposer_user_id, stakeAddr: grant.proposer_stake_addr },
        });
      }
      if (!modRole) {
        return { status: 401, json: { ok: false, error: 'not a proposer or moderator' } };
      }
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
  const { db, now } = input;
  const { drepId, stakeAddr, poolId, ccCred, grantedRoles, modRole } = args;

  const user = await upsertUserFromAuth(db, {
    drepId,
    stakeAddr,
    poolId,
    ccCred,
    roles: grantedRoles,
    now: Math.floor(now ?? Date.now() / 1000),
  });

  return mintSessionResult(input, user, modRole);
}

/**
 * Shared session tail: derive the session roles from the resolved user row,
 * mint the KV session (caching the user's drep_id so consumers resolve the
 * logged-in DRep without a per-request D1 read; it is immutable for the
 * session), and return the 200 result with the Set-Cookie. Used by both the
 * writer flow (finishLogin, after upsert) and the delegator flow (after
 * resolveDelegatorAccount), so the session/cookie shape never drifts.
 */
async function mintSessionResult(
  input: VerifyInput,
  user: User,
  modRole: ModeratorRole | null,
  opts?: {
    roles?: string[];
    drepId?: string | null;
    grantId?: string | null;
    actsFor?: { userId: string; stakeAddr: string } | null;
  },
): Promise<VerifyResult> {
  const { sessionKv, now, secure, db } = input;
  const roles = opts?.roles ?? rolesFromUser(user, modRole);
  const drepId = opts?.roles ? (opts.drepId ?? null) : user.drep_id;
  const token = await createSession(
    sessionKv,
    { id: user.id, roles, drepId, grantId: opts?.grantId ?? null, actsFor: opts?.actsFor ?? null },
    { now, onCreate: sessionActivityHook(db) },
  );
  return {
    status: 200,
    json: { ok: true, user: { id: user.id, roles } },
    setCookie: buildSessionCookie(token, { secure }),
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
