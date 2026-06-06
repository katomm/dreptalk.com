// Pure, dependency-injected wallet login flow logic.
// No DOM imports; fully testable in Node.js with injected fetch and wallet API.
import { blake2b224 } from '../crypto/blake.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';

// Minimal CIP-30 + CIP-95 wallet API surface required for login.
export interface WalletApi {
  getRewardAddresses(): Promise<string[]>;
  signData(
    addr: string,
    payloadHex: string,
  ): Promise<{ signature: string; key: string }>;
  cip95?: {
    getPubDRepKey(): Promise<string>;
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
 *   2. Derive the signing address:
 *      - proposer: first reward address from CIP-30 getRewardAddresses().
 *      - drep: 28-byte Blake2b-224 hash of the DRep public key (CIP-95), as hex.
 *        signData takes the raw key-hash credential, not a bech32 address.
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
  deps?: Deps,
): Promise<LoginResult> {
  const fetchFn = deps?.fetchImpl ?? fetch;

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

    // Step 2: derive signing address.
    let addr: string;
    if (role === 'proposer') {
      const addrs = await api.getRewardAddresses();
      addr = addrs[0];
    } else {
      // DRep: CIP-95 required.
      if (!api.cip95) {
        return { ok: false, error: 'wallet does not support CIP-95' };
      }
      const pubKeyHex = await api.cip95.getPubDRepKey();
      // pubKeyHex is the raw 32-byte Ed25519 DRep public key as hex.
      // signData for DRep takes the 28-byte Blake2b-224 key hash as the addr.
      const pubKeyBytes = hexToBytes(pubKeyHex);
      const keyHash = blake2b224(pubKeyBytes);
      addr = bytesToHex(keyHash);
    }

    // Step 3: hex-encode the payload string (UTF-8).
    const payloadHex = bytesToHex(new TextEncoder().encode(payload));

    // Step 4: sign with wallet.
    const { signature, key } = await api.signData(addr, payloadHex);

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
    const e = err as { info?: unknown; message?: unknown } | null;
    const detail =
      (typeof e?.info === 'string' && e.info) ||
      (typeof e?.message === 'string' && e.message) ||
      'wallet connection or network error';
    return { ok: false, error: detail };
  }
}

