/// <reference types="@cloudflare/workers-types" />
// Testable handler for POST /api/auth/link-stake: binds a writer's stake
// wallet to their existing account. Astro route in
// src/pages/api/auth/link-stake.ts is a thin wrapper (writer-only gate +
// same-origin + rate-limit + env wiring) over this function, mirroring
// handlers.ts's convention.
//
// Security shape:
//  - Independent server-side verification of the CIP-8 signature and the
//    reward-address header (same check the proposer/delegator login path
//    uses, see checkRewardAddressHeader in handlers.ts). assertWalletNetwork
//    on the client is only a pre-check for UX; nothing here trusts it.
//  - The nonce domain is `link_stake:<userId>`, where `userId` MUST be the
//    caller's own authenticated session id, never a client-supplied value.
//    The route layer is responsible for that binding; this function just
//    uses whatever `userId` it is given as the domain and as the row to
//    update, so a caller that fed it an attacker-chosen id would defeat the
//    whole point -- see src/pages/api/auth/link-stake.ts.
import { consumeNonceForDomain } from './nonce.js';
import { verifyCip8 } from './cose.js';
import { checkRewardAddressHeader } from './handlers.js';
import { getUserById, getUserByStakeAddr } from '../db/users.js';
import { isHex, MAX_PAYLOAD_LEN, MAX_KEY_HEX_LEN, MAX_SIG_HEX_LEN } from '../validation/input.js';
import type { CardanoNetwork } from '../config/network.js';

export interface LinkStakeBody {
  payload: string;
  signatureHex: string;
  keyHex: string;
}

export interface LinkStakeInput {
  db: D1Database;
  // The AUTHENTICATED session's user id. Never source this from the request
  // body -- see the module doc comment above.
  userId: string;
  body: LinkStakeBody;
  network: CardanoNetwork;
  now?: number;
}

/** Injected dependencies for handleLinkStake. All fields optional; defaults are the real implementations. */
export interface LinkStakeDeps {
  consumeNonceForDomain?: (
    db: D1Database,
    payload: string,
    expectedDomain: string,
    opts?: { now?: number; maxAgeSec?: number },
  ) => Promise<boolean>;
}

export interface LinkStakeResult {
  status: number;
  json: unknown;
}

/**
 * Verifies a CIP-8 reward-address signature and, on success, links the
 * derived stake address to `input.userId`. Never throws; all failures are
 * caught and returned as a structured 4xx/5xx result.
 */
export async function handleLinkStake(input: LinkStakeInput, deps?: LinkStakeDeps): Promise<LinkStakeResult> {
  try {
    return await handleLinkStakeInternal(input, deps);
  } catch {
    // Unexpected internal error (e.g. a D1 failure that isn't the expected
    // unique-constraint collision): fail closed with a generic 500.
    return { status: 500, json: { ok: false, error: 'internal error' } };
  }
}

async function handleLinkStakeInternal(input: LinkStakeInput, deps?: LinkStakeDeps): Promise<LinkStakeResult> {
  const { db, userId, body, network, now } = input;
  const consumeFn = deps?.consumeNonceForDomain ?? consumeNonceForDomain;

  // Bound and format-check the untrusted fields before any hex decode, crypto,
  // or nonce consumption -- a malformed request should not burn the nonce.
  if (
    !body ||
    typeof body.payload !== 'string' ||
    typeof body.signatureHex !== 'string' ||
    typeof body.keyHex !== 'string' ||
    body.payload.length > MAX_PAYLOAD_LEN ||
    !isHex(body.keyHex, MAX_KEY_HEX_LEN) ||
    !isHex(body.signatureHex, MAX_SIG_HEX_LEN)
  ) {
    return { status: 400, json: { ok: false, error: 'invalid request' } };
  }

  // Single-use nonce, scoped to this exact account and this exact intent. The
  // domain is derived from `userId` (the authenticated session), never from
  // anything in the request body, so a proof issued for one account can never
  // be redeemed to link a stake address onto a different one.
  const nonceValid = await consumeFn(db, body.payload, `link_stake:${userId}`, { now });
  if (!nonceValid) {
    return { status: 401, json: { ok: false, error: 'invalid or expired nonce' } };
  }

  // Verify the CIP-8 signature over the exact nonce payload.
  const verifyResult = await verifyCip8({
    signatureHex: body.signatureHex,
    keyHex: body.keyHex,
    expectedPayload: body.payload,
  });
  if (!verifyResult.ok || !verifyResult.pubKey || !verifyResult.addressBytes) {
    return { status: 401, json: { ok: false, error: 'signature verification failed' } };
  }

  // Confirm the signed address is a reward address for this network (not a
  // DRep credential, not the other network's header) and derive the stake
  // address from the verified pubkey. Shared with the proposer/delegator
  // wallet-login path in handlers.ts.
  const check = checkRewardAddressHeader(verifyResult.addressBytes, verifyResult.pubKey, network);
  if (!check.ok) {
    return { status: 401, json: { ok: false, error: check.error } };
  }
  const { stakeAddr } = check;

  // Attempt the link. This only succeeds if the account has no stake_addr
  // yet; RETURNING tells us whether this call is the one that set it.
  let row: { id: string } | null;
  try {
    row = await db
      .prepare('UPDATE users SET stake_addr = ? WHERE id = ? AND stake_addr IS NULL RETURNING id')
      .bind(stakeAddr, userId)
      .first<{ id: string }>();
  } catch (error) {
    // The partial unique index on users.stake_addr rejects the UPDATE when
    // another account already owns this stake address. Confirm that via
    // getUserByStakeAddr before reporting a collision -- not every D1 error
    // means that, so a transient failure here still surfaces as a 500 via the
    // outer catch in handleLinkStake.
    const owner = await getUserByStakeAddr(db, stakeAddr);
    if (owner && owner.id !== userId) {
      return { status: 409, json: { ok: false, error: 'stake wallet already linked to another account' } };
    }
    throw error;
  }

  if (row) {
    return { status: 200, json: { ok: true, linked: true } };
  }

  // No row updated: either this account already has a stake_addr (same or
  // different), or the account itself is gone. Read back to tell those apart.
  const self = await getUserById(db, userId);
  if (!self) {
    // Should never happen for an authenticated session; treat it as an
    // auth/data error rather than silently reporting success.
    return { status: 401, json: { ok: false, error: 'unauthorized' } };
  }
  if (self.stake_addr === stakeAddr) {
    // Idempotent: this exact wallet is already linked to this account.
    return { status: 200, json: { ok: true, linked: true } };
  }
  return { status: 409, json: { ok: false, error: 'account already has a stake wallet' } };
}
