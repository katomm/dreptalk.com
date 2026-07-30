// Pure, dependency-injected logic for the "link your stake wallet" flow
// (Phase 3, Task 8). No DOM imports; fully testable in Node.js with an
// injected fetch and wallet API, mirroring walletLogin.ts's shape.
//
// Flow:
//   1. POST /api/auth/link-challenge (writer-only, same-origin) for a
//      single-use nonce payload.
//   2. Read the wallet's first reward address (getRewardAddresses()[0]) and
//      sign the hex-encoded payload with it (CIP-8 signData), exactly like
//      the proposer/delegator login path.
//   3. POST /api/auth/link-stake with { payload, signatureHex, keyHex }.
//
// A second, much smaller function posts /api/delegation/track, the opt-in
// step offered after a successful link.
import { bytesToHex } from '../crypto/hex.js';
import { walletErrorDetail } from '../wallet/walletError.js';
import { assertWalletNetwork, WALLET_NETWORK_MISMATCH } from '../wallet/networkGuard.js';
import type { WalletApi } from './walletLogin.js';
import type { CardanoNetwork } from '../config/network.js';

export interface LinkStakeWalletResult {
  ok: boolean;
  linked?: boolean;
  error?: string;
}

interface Deps {
  fetchImpl?: typeof fetch;
}

/**
 * Runs the full wallet-sign link flow against /api/auth/link-challenge and
 * /api/auth/link-stake. Never throws: all failures are caught and returned as
 * { ok: false, error }.
 */
export async function linkStakeWallet(
  api: WalletApi,
  network: CardanoNetwork,
  deps?: Deps,
): Promise<LinkStakeWalletResult> {
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
    // Step 1: get the link-challenge payload.
    const challengeRes = await fetchFn('/api/auth/link-challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
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

    // Step 3: POST link-stake.
    const linkRes = await fetchFn('/api/auth/link-stake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload, signatureHex: signature, keyHex: key }),
    });
    const data = (await linkRes.json().catch(() => null)) as
      | { ok: boolean; linked?: boolean; error?: string }
      | null;

    if (!linkRes.ok || !data?.ok) {
      return { ok: false, error: data?.error || `link failed (HTTP ${linkRes.status})` };
    }
    return { ok: true, linked: data.linked };
  } catch (err) {
    const detail = walletErrorDetail(err) ?? 'wallet connection or network error';
    return { ok: false, error: detail };
  }
}

export interface TrackDelegationResult {
  ok: boolean;
  status?: 'pending' | 'resolved';
  delegationType?: string | null;
  drepId?: string | null;
  error?: string;
}

/**
 * Opts the signed-in writer into ongoing delegation tracking (POST
 * /api/delegation/track). Requires a stake wallet already linked. Never
 * throws: failures are caught and returned as { ok: false, error }.
 */
export async function trackDelegation(deps?: Deps): Promise<TrackDelegationResult> {
  const fetchFn = deps?.fetchImpl ?? fetch;
  try {
    const res = await fetchFn('/api/delegation/track', { method: 'POST' });
    const data = (await res.json().catch(() => null)) as
      | { ok: boolean; status?: 'pending' | 'resolved'; delegationType?: string | null; drepId?: string | null; error?: string }
      | null;
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error || `track failed (HTTP ${res.status})` };
    }
    return { ok: true, status: data.status, delegationType: data.delegationType, drepId: data.drepId };
  } catch (err) {
    return { ok: false, error: walletErrorDetail(err) ?? 'network error' };
  }
}
