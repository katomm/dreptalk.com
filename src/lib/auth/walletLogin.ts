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
 *   2. Derive the signing address:
 *      - proposer: first reward address from CIP-30 getRewardAddresses().
 *      - drep: CIP-19 type-6 (enterprise) address built from the Blake2b-224
 *        DRep key hash (CIP-95 getPubDRepKey), signed via cip95.signData when
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

    // Step 2: derive the signing address and select the signer.
    let addr: string;
    let signData = api.signData.bind(api);
    if (role === 'proposer') {
      const addrs = await api.getRewardAddresses();
      addr = addrs[0];
    } else {
      // DRep: CIP-95 required to read the DRep key.
      if (!api.cip95) {
        return { ok: false, error: 'wallet does not support CIP-95' };
      }
      const pubKeyHex = await api.cip95.getPubDRepKey();
      // pubKeyHex is the raw 32-byte Ed25519 DRep public key. Sign a CIP-19
      // type-6 (enterprise) address built from its key hash; CIP-95 wallets sign
      // that with the DRep key. Prefer the namespaced cip95.signData; fall back
      // to the base signData, which most wallets route to the DRep key too.
      const keyHash = blake2b224(hexToBytes(pubKeyHex));
      addr = drepCredentialAddress(keyHash, network);
      if (api.cip95.signData) {
        signData = api.cip95.signData.bind(api.cip95);
      }
    }

    // Step 3: hex-encode the payload string (UTF-8).
    const payloadHex = bytesToHex(new TextEncoder().encode(payload));

    // Step 4: sign with wallet.
    const { signature, key } = await signData(addr, payloadHex);

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

