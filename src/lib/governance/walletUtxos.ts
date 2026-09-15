// Wallet funding universe and input selection, shared by every client-side
// transaction builder here.
//
// These flows build certificate-only or vote-only transactions with no payment
// output. The SDK's automatic coin selection is driven by outputs, so with none
// it selects no inputs and reports "Available: 0" even on a funded wallet,
// regardless of build({ availableUtxos }). We therefore select inputs ourselves
// and pass them via collectFrom.

import { Address, Client, UTxO, mainnet, preprod } from '@evolution-sdk/evolution';
import type { CardanoNetwork } from '../config/network.js';

// WalletApi is not re-exported from the SDK barrel. We define a structurally
// compatible interface (a strict superset of what we actually call) so callers
// can pass the raw CIP-30 api object without any cast. The shape mirrors
// Wallet.WalletApi exactly.
export interface WalletApi {
  getUsedAddresses(): Promise<ReadonlyArray<string>>;
  getUnusedAddresses(): Promise<ReadonlyArray<string>>;
  getRewardAddresses(): Promise<ReadonlyArray<string>>;
  getUtxos(): Promise<ReadonlyArray<string>>;
  signTx(txCborHex: string, partialSign: boolean): Promise<string>;
  signData(addressHex: string, payload: string | Uint8Array): Promise<{ payload: string | Uint8Array; signature: string }>;
  submitTx(txCborHex: string): Promise<string>;
}

/**
 * Headroom over the funded amount, covering the network fee, the change output's
 * min-UTxO, and small protocol-parameter drift, so selection never picks a set
 * that is short by a fee's worth. A vote tx has no deposit and needs only this,
 * a registration adds its deposit on top.
 */
export const FUNDING_HEADROOM_LOVELACE = 5_000_000n;

/**
 * Collects the connected wallet's UTxOs across all of its addresses, reusing the
 * SDK's own Koios decoding via a read client. Used as the funding universe for
 * input selection and as build({ availableUtxos }).
 */
export async function collectWalletUtxos(
  network: CardanoNetwork,
  origin: string,
  walletApi: WalletApi,
): Promise<UTxO.UTxO[]> {
  const reader = Client.make(network === 'mainnet' ? mainnet : preprod).withKoios({
    baseUrl: `${origin}/api/koios`,
  });

  const used = await walletApi.getUsedAddresses();
  const addresses = used.length > 0 ? used : await walletApi.getUnusedAddresses();

  const perAddress = await Promise.all(
    addresses.map((addressHex) => reader.getUtxos(Address.fromHex(addressHex))),
  );

  return dedupeByOutRef(perAddress.flat());
}

/**
 * Collapses UTxOs that share an output reference. An address list is normally
 * disjoint, but a wallet returning the same address twice would otherwise have
 * its balance counted twice, and the tx would be built on an input it cannot
 * spend twice. Separate outputs of one transaction differ in their index and are
 * kept apart.
 */
export function dedupeByOutRef(utxos: UTxO.UTxO[]): UTxO.UTxO[] {
  const byRef = new Map<string, UTxO.UTxO>();
  for (const utxo of utxos) {
    byRef.set(UTxO.toOutRefString(utxo), utxo);
  }
  return [...byRef.values()];
}

/** Lovelace in a UTxO (0 if absent), as a bigint for exact comparison. */
export function utxoLovelace(utxo: UTxO.UTxO): bigint {
  return BigInt(utxo.assets?.lovelace ?? 0n);
}

/**
 * Total lovelace across a UTxO set. For a funding PRE-check: pickInputsToCover
 * deliberately returns everything on an underfunded wallet and lets the builder
 * report the shortfall, which is right where the SDK's own balance error is the
 * best message available. A flow that can say something more useful than that
 * (naming the deposit, or telling a Preview wallet apart from an empty one)
 * compares this against its requirement first.
 */
export function totalLovelace(utxos: UTxO.UTxO[]): bigint {
  return utxos.reduce((sum, utxo) => sum + utxoLovelace(utxo), 0n);
}

/**
 * Picks the fewest wallet UTxOs (largest first) whose combined lovelace covers
 * `minLovelace`, falling back to all UTxOs if the wallet cannot reach it. The
 * caller sizes `minLovelace` to its own funding need (a deposit plus the
 * headroom, or the headroom alone). Largest-first keeps the input count, and so
 * the tx size, small.
 *
 * Returning everything on an underfunded wallet is deliberate: the builder then
 * fails with the SDK's own balance error, which names the actual shortfall,
 * rather than a selection error that hides it.
 */
export function pickInputsToCover(utxos: UTxO.UTxO[], minLovelace: bigint): UTxO.UTxO[] {
  const sorted = [...utxos].sort((a, b) => {
    const av = utxoLovelace(a);
    const bv = utxoLovelace(b);
    return av < bv ? 1 : av > bv ? -1 : 0;
  });

  const picked: UTxO.UTxO[] = [];
  let sum = 0n;
  for (const utxo of sorted) {
    picked.push(utxo);
    sum += utxoLovelace(utxo);
    if (sum >= minLovelace) return picked;
  }
  return sorted;
}
