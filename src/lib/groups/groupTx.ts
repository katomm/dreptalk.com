// Client side builder of DRep group transactions. The connected wallet pays the fee, the group
// payload goes into metadata under the group label, every key whose consent the action needs is a
// required signer. The unsigned tx is posted to the server, which binds and previews these exact
// bytes and later splices the collected witnesses next to the original body.
import {
  Address,
  KeyHash,
  Time,
  Transaction,
  TransactionHash,
  TransactionMetadatum,
  type UTxO,
  mainnet,
  preprod,
} from '@evolution-sdk/evolution';
import { GROUPS_LABEL } from 'drep-groups';
import { DREPTALK_CIP20_LABEL, dreptalkCip20Metadatum } from '../cardano/tx.js';
import type { CardanoNetwork } from '../config/network.js';
import { type DrepTxBuilder, makeClient, signAndSubmit } from '../governance/drepTx.js';
import { collectWalletUtxos, FUNDING_HEADROOM_LOVELACE, pickInputsToCover, type WalletApi } from '../governance/walletUtxos.js';
import { decodeGroupTx, unsignedShapeError } from './actionTx.js';
import { ACTION_TTL_SECONDS, WITNESS_FEE_BYTES } from './constants.js';
import { drepGroupsAvailable } from './gate.js';
import { FUNDS_HELD } from './view.js';

type ProtocolParameters = NonNullable<NonNullable<Parameters<DrepTxBuilder['build']>[0]>['fullProtocolParameters']>;
type SlotConfig = typeof preprod.slotConfig;

/** The slot timing of a network, the same chain parameters the SDK client of that network uses. */
export function slotConfigFor(network: CardanoNetwork): SlotConfig {
  return (network === 'mainnet' ? mainnet : preprod).slotConfig;
}

/**
 * Queues the group payload under the group label, every required signer, the validity interval
 * and the attribution tag. The payload bytes are the library's encoding, read back into a
 * metadatum that the SDK writes out byte for byte the same. No script is attached, the policies
 * travel in the payload.
 */
export function queueGroupOps(
  txb: DrepTxBuilder,
  parts: {
    payload: Uint8Array;
    requiredSigners: readonly string[];
    invalidHereafterSlot: bigint;
    invalidBeforeSlot?: bigint;
    slotConfig: SlotConfig;
  },
): DrepTxBuilder {
  const { slotConfig } = parts;
  let tx = txb.attachMetadata({ label: BigInt(GROUPS_LABEL), metadata: TransactionMetadatum.fromCBORBytes(parts.payload) });
  for (const key of parts.requiredSigners) tx = tx.addSigner({ keyHash: KeyHash.fromHex(key) });
  tx = tx.setValidity({
    to: Time.slotToUnixTime(parts.invalidHereafterSlot, slotConfig),
    ...(parts.invalidBeforeSlot === undefined ? {} : { from: Time.slotToUnixTime(parts.invalidBeforeSlot, slotConfig) }),
  });
  return tx.attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() });
}

/**
 * The optional keys that may sign without being required signers, each counted once. The SDK
 * budgets a witness for every required signer and input key only, the server also folds in the
 * witnesses of these keys.
 */
export function feeHeadroomKeys(requiredSigners: readonly string[], optionalKeys: readonly string[]): number {
  const required = new Set(requiredSigners.map((k) => k.toLowerCase()));
  return new Set(optionalKeys.map((k) => k.toLowerCase()).filter((k) => !required.has(k))).size;
}

/** The protocol parameters with the fee constant raised by one vkey witness per headroom key. */
export function withWitnessHeadroom(params: ProtocolParameters, keys: number): ProtocolParameters {
  return keys === 0 ? params : { ...params, minFeeB: params.minFeeB + keys * WITNESS_FEE_BYTES * params.minFeeA };
}

/** The UTxOs at a key payment address. The server refuses fee inputs at a script address. */
export function keyPaymentUtxos(utxos: readonly UTxO.UTxO[]): UTxO.UTxO[] {
  return utxos.filter((u) => !Address.isScript(u.address));
}

export type OutRef = { txHash: string; index: number };

const refOf = (txHash: string, index: number | bigint): string => `${txHash.toLowerCase()}#${index}`;

/** The UTxOs that none of the given output references names. */
export function withoutInputs(utxos: readonly UTxO.UTxO[], exclude: readonly OutRef[]): UTxO.UTxO[] {
  if (exclude.length === 0) return [...utxos];
  const held = new Set(exclude.map((r) => refOf(r.txHash, r.index)));
  return utxos.filter((u) => !held.has(refOf(TransactionHash.toHex(u.transactionId), u.index)));
}

export interface GroupTxInputs {
  utxos: readonly UTxO.UTxO[];
  params: ProtocolParameters;
  changeAddress?: Address.Address;
  payload: Uint8Array;
  requiredSigners: string[];
  optionalKeys: string[];
  tipSlot: number;
  invalidBeforeSlot?: number;
  slotConfig: SlotConfig;
  /** Wallet UTxOs that open actions already spend, never selected again. */
  excludeInputs?: readonly OutRef[];
}

/**
 * Builds the unsigned group transaction on a builder from given UTxOs and protocol parameters,
 * without any provider call. Exported for the offline tests, buildGroupTx supplies the live values.
 */
export async function buildGroupTxFrom(txb: DrepTxBuilder, i: GroupTxInputs): Promise<{ unsignedTxHex: string; bodyHashHex: string }> {
  const keyed = keyPaymentUtxos(i.utxos);
  if (keyed.length === 0) throw new Error('The wallet holds no ada at a key payment address to pay the fee.');
  const funding = withoutInputs(keyed, i.excludeInputs ?? []);
  if (funding.length === 0) throw new Error(FUNDS_HELD);
  const inputs = pickInputsToCover(funding, FUNDING_HEADROOM_LOVELACE);
  const queued = queueGroupOps(txb, {
    payload: i.payload,
    requiredSigners: i.requiredSigners,
    invalidHereafterSlot: BigInt(i.tipSlot + ACTION_TTL_SECONDS),
    invalidBeforeSlot: i.invalidBeforeSlot === undefined ? undefined : BigInt(i.invalidBeforeSlot),
    slotConfig: i.slotConfig,
  }).collectFrom({ inputs });
  const built = await queued.build({
    // Only key address UTxOs, so coin selection cannot add a script address input either.
    availableUtxos: funding,
    fullProtocolParameters: withWitnessHeadroom(i.params, feeHeadroomKeys(i.requiredSigners, i.optionalKeys)),
    ...(i.changeAddress ? { changeAddress: i.changeAddress } : {}),
  });
  const unsignedTxHex = Transaction.toCBORHex(await built.toTransaction());
  // The server splices witnesses next to the body bytes as they are, so the shape is checked here
  // and the hash is taken over those bytes, never over a re-encoded body.
  const decoded = decodeGroupTx(unsignedTxHex);
  const shape = unsignedShapeError(decoded);
  if (shape) throw new Error(`Unexpected transaction shape: ${shape}.`);
  return { unsignedTxHex, bodyHashHex: decoded.bodyHash };
}

/**
 * The network's slot of the wall clock, which is the tip slot within seconds. The server accepts a
 * validity end that far off.
 */
export function wallClockSlot(network: CardanoNetwork, now = Date.now()): number {
  return Number(Time.unixTimeToSlot(BigInt(now), slotConfigFor(network)));
}

function assertGroupsNetwork(network: CardanoNetwork): void {
  if (!drepGroupsAvailable(network)) throw new Error('DRep groups are not available on this network.');
}

/**
 * Builds the unsigned group transaction funded by the connected wallet. The validity ends
 * ACTION_TTL_SECONDS after the tip slot, `invalidBeforeSlot` is only for a member script with an
 * after lock, `excludeInputs` are the fee inputs of the initiator's open actions. Requires a live
 * wallet and a reachable Koios proxy.
 */
export async function buildGroupTx(opts: {
  walletApi: WalletApi;
  network: CardanoNetwork;
  origin: string;
  payload: Uint8Array;
  requiredSigners: string[];
  optionalKeys: string[];
  tipSlot: number;
  invalidBeforeSlot?: number;
  excludeInputs?: readonly OutRef[];
}): Promise<{ unsignedTxHex: string; bodyHashHex: string }> {
  assertGroupsNetwork(opts.network);
  const client = makeClient(opts.network, opts.origin, opts.walletApi);
  const [utxos, params] = await Promise.all([
    collectWalletUtxos(opts.network, opts.origin, opts.walletApi),
    client.getProtocolParameters(),
  ]);
  const { payload, requiredSigners, optionalKeys, tipSlot, invalidBeforeSlot, excludeInputs } = opts;
  return buildGroupTxFrom(client.newTx(), {
    utxos,
    excludeInputs,
    params,
    payload,
    requiredSigners,
    optionalKeys,
    tipSlot,
    invalidBeforeSlot,
    slotConfig: client.chain.slotConfig,
  });
}

/**
 * Builds the transaction that spends exactly the given fee inputs back to the wallet, all value
 * going to the change output. Coin selection sees only those inputs, so a set too small for the fee
 * fails instead of pulling in other wallet UTxOs. Throws when a fee input is not among the UTxOs.
 * Exported for the offline tests, `params` and `changeAddress` are only set there.
 */
export async function buildSendToSelfFrom(
  txb: DrepTxBuilder,
  i: {
    utxos: readonly UTxO.UTxO[];
    inputs: ReadonlyArray<{ txHash: string; index: number }>;
    params?: ProtocolParameters;
    changeAddress?: Address.Address;
  },
): Promise<Awaited<ReturnType<DrepTxBuilder['build']>>> {
  const byRef = new Map(keyPaymentUtxos(i.utxos).map((u) => [refOf(TransactionHash.toHex(u.transactionId), u.index), u]));
  const spent: UTxO.UTxO[] = [];
  for (const ref of i.inputs) {
    const utxo = byRef.get(refOf(ref.txHash, ref.index));
    if (!utxo) throw new Error('A fee input of this transaction is no longer in the wallet.');
    spent.push(utxo);
  }
  if (spent.length === 0) throw new Error('No fee inputs to spend.');
  const queued = txb
    .collectFrom({ inputs: spent })
    .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() });
  return queued.build({
    availableUtxos: spent,
    ...(i.params ? { fullProtocolParameters: i.params } : {}),
    ...(i.changeAddress ? { changeAddress: i.changeAddress } : {}),
  });
}

/**
 * Spends the fee inputs of a pending group transaction back to the wallet, which makes that
 * transaction unsubmittable for good. Fails when a fee input is no longer in the wallet.
 */
export async function buildSendToSelf(opts: {
  walletApi: WalletApi;
  network: CardanoNetwork;
  origin: string;
  inputs: Array<{ txHash: string; index: number }>;
}): Promise<{ txHash: string }> {
  assertGroupsNetwork(opts.network);
  const client = makeClient(opts.network, opts.origin, opts.walletApi);
  const utxos = await collectWalletUtxos(opts.network, opts.origin, opts.walletApi);
  const built = await buildSendToSelfFrom(client.newTx(), { utxos, inputs: opts.inputs });
  return signAndSubmit(built, opts.walletApi);
}
