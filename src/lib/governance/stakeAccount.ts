// Client-side check of a wallet's stake-account state, used to gate vote
// delegation. A vote_deleg certificate is rejected by the node when the
// delegating stake key is not registered on-chain, and wallets surface that
// only as a generic "failed to submit" error. Reading account_info first lets
// the delegation dialog explain the real reason instead.

import { hexToBytes } from '../crypto/hex.js';
import { encodeBech32 } from '../crypto/bech32.js';
import type { CardanoNetwork } from '../config/network.js';

/**
 * Re-encodes a CIP-30 reward address (29-byte hex: header + 28-byte credential)
 * as its bech32 stake address, which is what Koios /account_info expects. The
 * prefix follows the network: `stake` on mainnet, `stake_test` elsewhere.
 * Pure; exported for unit tests.
 */
export function rewardAddressToStakeBech32(rewardAddressHex: string, network: CardanoNetwork): string {
  const bytes = hexToBytes(rewardAddressHex);
  if (bytes.length !== 29) {
    throw new Error('Unexpected reward address length; expected a 29-byte stake address.');
  }
  return encodeBech32(network === 'mainnet' ? 'stake' : 'stake_test', bytes);
}

export interface StakeRegistration {
  /** True only when the stake key is currently registered on-chain. */
  registered: boolean;
}

/**
 * Reads the wallet's stake-account registration state via the /api/koios
 * account_info proxy. A never-seen stake address returns no row (treated as
 * unregistered); a deregistered one returns status "not registered". Uses a
 * direct fetch rather than the full Koios client so the delegation island
 * stays free of the zod-backed client bundle.
 */
export async function fetchStakeRegistration(opts: {
  rewardAddressHex: string;
  network: CardanoNetwork;
  origin: string;
}): Promise<StakeRegistration> {
  const stakeAddress = rewardAddressToStakeBech32(opts.rewardAddressHex, opts.network);
  const res = await fetch(`${opts.origin}/api/koios/account_info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
  });
  if (!res.ok) {
    throw new Error(`account_info request failed: ${res.status}`);
  }
  const rows = (await res.json()) as Array<{ status?: string }>;
  return {
    registered: rows[0]?.status === 'registered',
  };
}
