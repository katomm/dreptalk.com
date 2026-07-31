// Pure, dependency-injected logic for the co-proposer invite redemption flow
// (Phase 3, Task 8). No DOM imports; fully testable in Node.js with an
// injected fetch and wallet API, mirroring linkStakeWallet.ts's shape.
//
// Flow:
//   1. POST /api/auth/co-proposer/challenge { code } for a single-use nonce
//      payload bound to the invite's resolved grant. The caller never learns
//      or sends a grantId; the code is the only thing that identifies the
//      invite (see coProposerRedeem.ts).
//   2. Read the wallet's first reward address (getRewardAddresses()[0]) and
//      sign the hex-encoded payload with it (CIP-8 signData), exactly like
//      the proposer/delegator login path.
//   3. POST /api/auth/co-proposer/redeem with
//      { code, payload, signatureHex, keyHex, displayName }.
import { bytesToHex } from '../crypto/hex.js';
import { walletErrorDetail } from '../wallet/walletError.js';
import { assertWalletNetwork, networkMismatchMessage, WALLET_NETWORK_MISMATCH } from '../wallet/networkGuard.js';
import type { WalletApi } from './walletLogin.js';
import type { CardanoNetwork } from '../config/network.js';

export interface RedeemCoProposerResult {
  ok: boolean;
  error?: string;
}

interface Deps {
  fetchImpl?: typeof fetch;
}

/**
 * Runs the full wallet-sign invite redemption flow against
 * /api/auth/co-proposer/challenge and /api/auth/co-proposer/redeem. Never
 * throws: all failures are caught and returned as { ok: false, error }.
 */
export async function redeemCoProposerInvite(
  api: WalletApi,
  network: CardanoNetwork,
  code: string,
  displayName: string,
  deps?: Deps,
): Promise<RedeemCoProposerResult> {
  const fetchFn = deps?.fetchImpl ?? fetch;

  // Fail fast on the wrong wallet network, before any nonce is burned (same
  // reasoning as loginWithWallet's step 0).
  if (typeof api.getNetworkId === 'function') {
    try {
      await assertWalletNetwork({ getNetworkId: api.getNetworkId.bind(api) }, network);
    } catch (err) {
      return { ok: false, error: walletErrorDetail(err) ?? WALLET_NETWORK_MISMATCH };
    }
  }

  try {
    // Step 1: get the redeem-challenge payload for this invite code.
    const challengeRes = await fetchFn('/api/auth/co-proposer/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!challengeRes.ok) {
      const body = (await challengeRes.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error || 'challenge request failed' };
    }
    const { payload } = (await challengeRes.json()) as { payload: string };

    // Step 2: sign the payload with the wallet's reward address.
    const addrs = await api.getRewardAddresses();
    const addr = addrs[0];
    if (!addr) {
      return { ok: false, error: 'wallet has no reward address' };
    }
    const payloadHex = bytesToHex(new TextEncoder().encode(payload));
    const { signature, key } = await api.signData(addr, payloadHex);

    // Step 3: POST the redeem body.
    const redeemRes = await fetchFn('/api/auth/co-proposer/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, payload, signatureHex: signature, keyHex: key, displayName }),
    });
    const data = (await redeemRes.json().catch(() => null)) as { ok?: boolean; error?: string } | null;

    if (!redeemRes.ok || !data?.ok) {
      return { ok: false, error: data?.error || `redeem failed (HTTP ${redeemRes.status})` };
    }
    return { ok: true };
  } catch (err) {
    const detail = walletErrorDetail(err) ?? 'wallet connection or network error';
    return { ok: false, error: detail };
  }
}

/**
 * Maps the terse server error codes from co-proposer/challenge and
 * co-proposer/redeem to clear, human-readable sentences. Mirrors
 * friendlyLinkError in LinkStakeWallet.tsx.
 */
export function friendlyRedeemError(error: string | undefined, network: CardanoNetwork): string {
  const e = (error ?? '').toLowerCase();
  if (!e) return 'Could not join. Please try again.';

  if (e.includes(WALLET_NETWORK_MISMATCH)) return networkMismatchMessage(network);
  if (e.includes('invite unavailable')) {
    return 'This invite is no longer valid. Ask the proposer to send you a new one.';
  }
  if (e.includes('mandate_taken')) {
    return 'This wallet already writes for a proposer. Each wallet can hold only one co-proposer mandate at a time.';
  }
  if (e.includes('cannot invite yourself')) {
    return 'You cannot accept your own invite.';
  }
  if (e.includes('nonce')) {
    return 'Your invite challenge expired. Please try again.';
  }
  if (e.includes('address type mismatch') || e.includes('invalid address in signature')) {
    return 'This wallet did not sign with a stake address. Please pick the wallet whose stake key you want to use.';
  }
  if (e.includes('signature verification')) {
    return 'We could not verify your signature. Please try signing again.';
  }
  if (e.includes('invalid request')) {
    return 'Something was off with your name or the request. Please check it and try again.';
  }
  if (e.includes('rate_limited')) {
    return 'Too many attempts. Please wait a bit and try again.';
  }
  if (e.includes('forbidden')) {
    return 'Something was off with the request. Please reload the page and try again.';
  }
  if (e.includes('service unavailable') || e.includes('internal')) {
    return 'Could not join, the service may be busy. Please try again.';
  }
  const msg = error!.charAt(0).toUpperCase() + error!.slice(1);
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}
