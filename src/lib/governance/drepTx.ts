// Client-side builder for the Conway reg_drep transaction.
// Non-custodial: the server never sees a private key; the wallet extension signs and submits.
// Uses EvolutionSDK with our /api/koios proxy to avoid CORS on Koios endpoints.

import { Anchor, Client, Credential, KeyHash, Transaction, Url, mainnet, preprod } from '@evolution-sdk/evolution';
import { dreptalkCip20Metadatum, DREPTALK_CIP20_LABEL } from '../cardano/tx.js';
import { hexToBytes } from '../crypto/hex.js';
import type { CardanoNetwork } from '../config/network.js';

// WalletApi is not re-exported from the barrel. We define a structurally compatible
// interface (a strict superset of what we actually call) so callers can pass the
// raw CIP-30 api object without any cast. The shape mirrors Wallet.WalletApi exactly.
export interface WalletApi {
  getUsedAddresses(): Promise<ReadonlyArray<string>>;
  getUnusedAddresses(): Promise<ReadonlyArray<string>>;
  getRewardAddresses(): Promise<ReadonlyArray<string>>;
  getUtxos(): Promise<ReadonlyArray<string>>;
  signTx(txCborHex: string, partialSign: boolean): Promise<string>;
  signData(addressHex: string, payload: string | Uint8Array): Promise<{ payload: string | Uint8Array; signature: string }>;
  submitTx(txCborHex: string): Promise<string>;
}

export interface RetireDRepOpts {
  /** CIP-30 wallet API obtained from cardano[walletId].enable(). */
  walletApi: WalletApi;
  network: CardanoNetwork;
  /** 28-byte blake2b-224 of the CIP-95 DRep verification key. */
  drepKeyHash: Uint8Array;
  /** window.location.origin, used as the base for the /api/koios proxy. */
  origin: string;
}

export interface RegisterDRepOpts {
  /** CIP-30 wallet API obtained from cardano[walletId].enable(). */
  walletApi: WalletApi;
  network: CardanoNetwork;
  /** 28-byte blake2b-224 of the CIP-95 DRep verification key. */
  drepKeyHash: Uint8Array;
  /** Hosted metadata URL returned by POST /api/drep/metadata. */
  anchorUrl: string;
  /** 64-char blake2b-256 hex returned by the same endpoint. */
  anchorHashHex: string;
  /** window.location.origin, used as the base for the /api/koios proxy. */
  origin: string;
}

/**
 * Pure helper: constructs the typed Credential and Anchor values
 * from the raw inputs in RegisterDRepOpts. No network access required.
 * Exported for unit tests that verify construction without a live wallet.
 */
export function buildRegisterDrepParts(opts: {
  drepKeyHash: Uint8Array;
  anchorUrl: string;
  anchorHashHex: string;
}): { drepCredential: Credential.Credential; anchor: Anchor.Anchor } {
  const drepCredential = Credential.makeKeyHash(opts.drepKeyHash);

  // Anchor is an Effect Schema.TaggedClass. Its fields at the type level are:
  //   anchorUrl: Url.Url (another TaggedClass wrapping { href: string })
  //   anchorDataHash: Uint8Array (32 bytes; BytesFromHex is the decode schema, not the field type)
  // This direct construction matches the pattern in Anchor.js FromCDDL.decode and the arbitrary.
  const anchor = new Anchor.Anchor({
    anchorUrl: new Url.Url({ href: opts.anchorUrl }),
    anchorDataHash: hexToBytes(opts.anchorHashHex),
  });

  return { drepCredential, anchor };
}

/**
 * Builds the EvolutionSDK client wired to the network, our Koios proxy, and
 * the connected CIP-30 wallet. Shared by the register and retire builders so
 * both use the identical provider setup.
 */
function makeClient(network: CardanoNetwork, origin: string, walletApi: WalletApi) {
  return Client.make(network === 'mainnet' ? mainnet : preprod)
    .withKoios({ baseUrl: `${origin}/api/koios` })
    .withCip30(walletApi);
}

// The concrete EvolutionSDK tx-builder type our flows operate on (derived from
// makeClient so we never re-declare the SDK's param shapes). Each op returns the
// same builder, so the chain below is the SINGLE place addSigner (the DRep key
// as a required signer, which the fee depends on) is declared. Tests pass a
// recording stub cast to this type to assert the signer is declared.
type DrepTxBuilder = ReturnType<ReturnType<typeof makeClient>['newTx']>;

/**
 * Queues the reg_drep certificate, the DRep-key required signer, and the CIP-20
 * attribution tag onto a tx builder. The addSigner call is mandatory: the
 * reg_drep certificate is witnessed by the DRep key (which controls no input),
 * and EvolutionSDK only sizes the fee for input + native-script + declared
 * signers, so without it the fee is one vkey witness short.
 */
export function queueRegisterDrepOps(
  txb: DrepTxBuilder,
  parts: { drepCredential: Credential.Credential; anchor: Anchor.Anchor; drepKeyHash: Uint8Array },
): DrepTxBuilder {
  return txb
    .registerDRep({ drepCredential: parts.drepCredential, anchor: parts.anchor })
    .addSigner({ keyHash: KeyHash.fromBytes(parts.drepKeyHash) })
    .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() });
}

/** Like queueRegisterDrepOps, for the unreg_drep (retire) certificate. */
export function queueDeregisterDrepOps(
  txb: DrepTxBuilder,
  parts: { drepCredential: Credential.Credential; drepKeyHash: Uint8Array },
): DrepTxBuilder {
  return txb
    .deregisterDRep({ drepCredential: parts.drepCredential })
    .addSigner({ keyHash: KeyHash.fromBytes(parts.drepKeyHash) })
    .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() });
}

/**
 * Builds, signs, and submits a Conway reg_drep certificate transaction.
 *
 * The wallet extension performs signing and submission; the server is
 * never involved in key operations. The CIP-20 attribution tag (label 674)
 * is attached so chain observers can identify DRepTalk-originated actions.
 *
 * Requires a live wallet and a reachable Koios provider. Not unit-testable
 * offline; covered by the preprod e2e suite in Phase B-11.
 */
export async function registerDRep(opts: RegisterDRepOpts): Promise<{ txHash: string }> {
  const { drepCredential, anchor } = buildRegisterDrepParts({
    drepKeyHash: opts.drepKeyHash,
    anchorUrl: opts.anchorUrl,
    anchorHashHex: opts.anchorHashHex,
  });

  const client = makeClient(opts.network, opts.origin, opts.walletApi);

  const built = await queueRegisterDrepOps(client.newTx(), {
    drepCredential,
    anchor,
    drepKeyHash: opts.drepKeyHash,
  }).build();

  const unsignedTxHex = Transaction.toCBORHex(await built.toTransaction());
  const witnessSetHex = await opts.walletApi.signTx(unsignedTxHex, false);
  const signedTxHex = Transaction.addVKeyWitnessesHex(unsignedTxHex, witnessSetHex);
  const txHash = await opts.walletApi.submitTx(signedTxHex);

  return { txHash };
}

/**
 * Builds, signs, and submits a Conway unreg_drep certificate transaction
 * (DRep retirement / deregistration). No metadata document is involved.
 *
 * The SDK reads the drepDeposit from protocol parameters and refunds it
 * automatically; the caller does not pass a deposit. The wallet extension
 * performs signing and submission; the server is never involved in key
 * operations. The CIP-20 attribution tag (label 674) is attached so chain
 * observers can identify DRepTalk-originated actions.
 *
 * Requires a live wallet and a reachable Koios provider. Not unit-testable
 * offline; mirrors registerDRep and is covered by the preprod e2e suite.
 */
export async function retireDRep(opts: RetireDRepOpts): Promise<{ txHash: string }> {
  const drepCredential = Credential.makeKeyHash(opts.drepKeyHash);

  const client = makeClient(opts.network, opts.origin, opts.walletApi);

  const built = await queueDeregisterDrepOps(client.newTx(), {
    drepCredential,
    drepKeyHash: opts.drepKeyHash,
  }).build();

  const unsignedTxHex = Transaction.toCBORHex(await built.toTransaction());
  const witnessSetHex = await opts.walletApi.signTx(unsignedTxHex, false);
  const signedTxHex = Transaction.addVKeyWitnessesHex(unsignedTxHex, witnessSetHex);
  const txHash = await opts.walletApi.submitTx(signedTxHex);

  return { txHash };
}
