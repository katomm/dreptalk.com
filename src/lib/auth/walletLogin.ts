// Pure, dependency-injected wallet login flow logic.
// No DOM imports; fully testable in Node.js with injected fetch and wallet API.
import { blake2b224 } from '../crypto/blake.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';
import { walletErrorDetail } from '../wallet/walletError.js';
import { assertWalletNetwork } from '../wallet/networkGuard.js';
import { drepCredentialAddress } from '../cardano/identity.js';
import type { CardanoNetwork } from '../config/network.js';

// Minimal CIP-30 + CIP-95 wallet API surface required for login.
export interface WalletApi {
  // Optional so injected test doubles stay minimal; every CIP-30 wallet has it.
  getNetworkId?(): Promise<number>;
  getRewardAddresses(): Promise<string[]>;
  signData(
    addr: string,
    payloadHex: string,
  ): Promise<{ signature: string; key: string }>;
  cip95?: {
    getPubDRepKey(): Promise<string>;
    // CIP-95 adds a namespaced signData that signs with the DRep key. When
    // present we prefer it; otherwise we fall back to the base CIP-30 signData,
    // which most wallets route to the DRep key for a type-6 DRep address.
    signData?(
      addr: string,
      payloadHex: string,
    ): Promise<{ signature: string; key: string }>;
  };
}

export interface LoginResult {
  ok: boolean;
  user?: { id: string; roles: string[] };
  error?: string;
}

interface Deps {
  fetchImpl?: typeof fetch;
}

/**
 * Runs the full wallet-sign login flow against the DRepTalk auth endpoints.
 *
 * Steps:
 *   1. POST /api/auth/challenge to get a one-time payload string.
 *   2. Derive the signing address candidate(s):
 *      - proposer: first reward address from CIP-30 getRewardAddresses().
 *      - drep: the Blake2b-224 DRep key hash from CIP-95 getPubDRepKey, offered
 *        both as the bare key-hash hex (the literal CIP-95 DRepID) and as a
 *        CIP-19 type-6 (enterprise) address; signed via cip95.signData when
 *        available, else the base signData.
 *   3. Hex-encode the payload (UTF-8 bytes to hex).
 *   4. Call wallet.signData(addr, payloadHex).
 *   5. POST /api/auth/verify with { payload, signatureHex, keyHex, role }.
 *   6. Return { ok, user } on success or { ok: false, error } on any failure.
 *
 * Never throws. All errors are caught and returned as { ok: false, error }.
 */
export async function loginWithWallet(
  api: WalletApi,
  role: 'drep' | 'proposer',
  network: CardanoNetwork,
  deps?: Deps,
): Promise<LoginResult> {
  const fetchFn = deps?.fetchImpl ?? fetch;

  // Step 0: fail fast with a clear message when the wallet is on the wrong
  // network. Without this, signData fails with the wallet's own validation
  // error (e.g. Eternl's '"address" contains an invalid value') because the
  // signing address is built for the app's network. Checked before the
  // challenge so no nonce is burned on a doomed attempt.
  if (typeof api.getNetworkId === 'function') {
    try {
      await assertWalletNetwork({ getNetworkId: api.getNetworkId.bind(api) }, network);
    } catch (err) {
      return { ok: false, error: walletErrorDetail(err) ?? 'wallet network mismatch' };
    }
  }

  try {
    // Step 1: get challenge payload.
    const challengeRes = await fetchFn('/api/auth/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!challengeRes.ok) {
      return { ok: false, error: 'challenge request failed' };
    }
    const { payload } = (await challengeRes.json()) as { payload: string };

    // Step 2: derive the signing address candidate(s) and select the signer.
    let addrCandidates: string[];
    let signData = api.signData.bind(api);
    if (role === 'proposer') {
      const addrs = await api.getRewardAddresses();
      addrCandidates = [addrs[0]];
    } else {
      // DRep: CIP-95 required to read the DRep key.
      if (!api.cip95) {
        return { ok: false, error: 'wallet does not support CIP-95' };
      }
      const pubKeyHex = await api.cip95.getPubDRepKey();
      // pubKeyHex is the raw 32-byte Ed25519 DRep public key. CIP-95 wallets
      // disagree on how the DRep `addr` argument must be encoded, so we offer the
      // forms in order of compatibility and use the first the wallet accepts:
      //   1. the bare 28-byte DRep key-hash hex (the literal CIP-95 DRepID),
      //   2. a CIP-19 type-6 (enterprise) address (network header + key hash).
      // Some wallets only sign the bare DRepID and reject the type-6 form as a
      // generic signing failure; others accept the address form. The identity is
      // bound server-side from the signed public key, not from this header.
      const keyHash = blake2b224(hexToBytes(pubKeyHex));
      addrCandidates = [bytesToHex(keyHash), drepCredentialAddress(keyHash, network)];
      if (api.cip95.signData) {
        signData = api.cip95.signData.bind(api.cip95);
      }
    }

    // Step 3: hex-encode the payload string (UTF-8).
    const payloadHex = bytesToHex(new TextEncoder().encode(payload));

    // Step 4: sign with the first address form the wallet accepts.
    const { signature, key } = await signWithFirstAccepted(signData, addrCandidates, payloadHex);

    // Step 5: POST verify.
    const verifyRes = await fetchFn('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload,
        signatureHex: signature,
        keyHex: key,
        role,
      }),
    });

    if (!verifyRes.ok) {
      // Surface the server's specific reason (e.g. "not an active DRep",
      // "signature verification failed", "address type mismatch for role",
      // "invalid or expired nonce") instead of a flat "login failed".
      const body = (await verifyRes.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error || `login failed (HTTP ${verifyRes.status})` };
    }

    const data = (await verifyRes.json()) as { ok: boolean; user?: { id: string; roles: string[] } };
    return { ok: true, user: data.user };
  } catch (err) {
    // Wallet rejection (user declined), network error, or other failure.
    // CIP-30 wallet errors carry { code, info }; prefer that detail when present.
    const detail = walletErrorDetail(err) ?? 'wallet connection or network error';
    return { ok: false, error: detail };
  }
}

/**
 * Signs the payload with the first `addr` form the wallet accepts.
 *
 * CIP-95 wallets disagree on how the DRep `addr` argument must be encoded: some
 * sign only the bare key-hash hex (the literal CIP-95 DRepID) and reject a
 * CIP-19 type-6 enterprise address as a generic signing failure (VESPR surfaces
 * this as a "user rejected" error), while others accept the address form. We try
 * the candidates in order and return the first signature. A genuine user decline
 * (CIP-30 DataSignError code 3) stops the loop immediately so we never re-prompt
 * after the user said no; any other failure falls through to the next encoding.
 */
async function signWithFirstAccepted(
  signData: (addr: string, payloadHex: string) => Promise<{ signature: string; key: string }>,
  addrCandidates: string[],
  payloadHex: string,
): Promise<{ signature: string; key: string }> {
  let lastErr: unknown;
  for (let i = 0; i < addrCandidates.length; i++) {
    try {
      return await signData(addrCandidates[i], payloadHex);
    } catch (err) {
      lastErr = err;
      if (isUserDecline(err) || i === addrCandidates.length - 1) throw err;
    }
  }
  throw lastErr;
}

/** True when a CIP-30 wallet error is an explicit user rejection (DataSignError UserDeclined = 3). */
function isUserDecline(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 3;
}

