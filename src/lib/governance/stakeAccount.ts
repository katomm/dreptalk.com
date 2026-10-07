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

/**
 * One POST to the /api/koios/account_info proxy, the rows as Koios sent them.
 * Throws on a failed request so the caller can offer a retry instead of
 * guessing.
 */
async function postAccountInfo(
  stakeAddresses: readonly string[],
  origin: string,
): Promise<Array<{ stake_address?: string; status?: string }>> {
  const res = await fetch(`${origin}/api/koios/account_info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ _stake_addresses: stakeAddresses }),
  });
  if (!res.ok) {
    throw new Error(`account_info request failed: ${res.status}`);
  }
  return (await res.json()) as Array<{ stake_address?: string; status?: string }>;
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
  const rows = await postAccountInfo([stakeAddress], opts.origin);
  return {
    registered: rows[0]?.status === 'registered',
  };
}

/**
 * Registration of several stake addresses in one /api/koios/account_info
 * call, keyed by the bech32 address as given. A never-seen address returns no
 * row and counts as unregistered, exactly like fetchStakeRegistration. Rows
 * are matched by their own stake_address field rather than by position, since
 * Koios does not promise to answer in request order. Throws on a failed
 * request.
 */
export async function fetchStakeRegistrations(opts: {
  stakeAddresses: readonly string[];
  origin: string;
}): Promise<Map<string, boolean>> {
  const unique = [...new Set(opts.stakeAddresses)];
  const registered = new Map<string, boolean>(unique.map((address) => [address, false]));
  if (unique.length === 0) return registered;
  const rows = await postAccountInfo(unique, opts.origin);
  for (const row of rows) {
    if (row.stake_address && registered.has(row.stake_address)) {
      registered.set(row.stake_address, row.status === 'registered');
    }
  }
  return registered;
}
