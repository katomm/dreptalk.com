// Wallet network guard: fail clearly when the connected wallet is on a different
// Cardano network than the app. Call right after enable(), before building any
// transaction, so the user sees "switch your wallet network" instead of the
// Evolution SDK's cryptic "Wallet network mismatch: wallet is on network 1 but
// chain id is 0". CIP-30 getNetworkId(): 1 = mainnet, 0 = testnets.
import type { CardanoNetwork } from '../config/network.js';

/** CIP-30 network id for a Cardano network: 1 = mainnet, 0 = testnets (preprod/preview). */
export function expectedNetworkId(network: CardanoNetwork): number {
  return network === 'mainnet' ? 1 : 0;
}

/** Short, user-facing name the app's network goes by (also what the user switches the wallet to). */
function appNetworkName(network: CardanoNetwork): string {
  return network === 'mainnet' ? 'Mainnet' : 'Preprod';
}

/** Human label for the wallet's reported CIP-30 network id. */
function walletNetworkName(id: number): string {
  return id === 1 ? 'Mainnet' : 'a testnet';
}

/**
 * The one user-facing wording for a wallet/app network mismatch, shared by the
 * client guard and the login error mapping so the copy cannot drift. When the
 * wallet's network id is unknown (e.g. the server detected the mismatch), the
 * wallet side reads "a different network".
 */
export function networkMismatchMessage(network: CardanoNetwork, walletNetworkId?: number): string {
  const target = appNetworkName(network);
  const from = walletNetworkId == null ? 'a different network' : walletNetworkName(walletNetworkId);
  return `Your wallet is on ${from}, but DRepTalk is running on ${target}. Please switch your wallet to ${target} and try again.`;
}

/**
 * Throws a clear, human-readable error when the connected wallet's network does
 * not match the app's network. No-op on a match. Use in every wallet flow that
 * signs anything: transactions get the Evolution SDK's cryptic mismatch error
 * otherwise, and login signData fails with the wallet's own validation error
 * (e.g. Eternl's '"address" contains an invalid value').
 */
export async function assertWalletNetwork(
  api: { getNetworkId(): Promise<number> },
  network: CardanoNetwork,
): Promise<void> {
  const walletId = await api.getNetworkId();
  if (walletId !== expectedNetworkId(network)) {
    throw new Error(networkMismatchMessage(network, walletId));
  }
}
