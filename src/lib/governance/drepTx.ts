// Client-side builder for the Conway reg_drep transaction.
// Non-custodial: the server never sees a private key; the wallet extension signs and submits.
// Uses EvolutionSDK with our /api/koios proxy to avoid CORS on Koios endpoints.

import { Anchor, Client, Credential, DRep, KeyHash, ScriptHash, Transaction, Url, mainnet, preprod } from '@evolution-sdk/evolution';
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

/** Like queueRegisterDrepOps, for the update_drep certificate (new anchor, no deposit). */
export function queueUpdateDrepOps(
  txb: DrepTxBuilder,
  parts: { drepCredential: Credential.Credential; anchor: Anchor.Anchor; drepKeyHash: Uint8Array },
): DrepTxBuilder {
  return txb
    .updateDRep({ drepCredential: parts.drepCredential, anchor: parts.anchor })
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

/**
 * Builds, signs, and submits a Conway update_drep certificate transaction
 * that replaces the DRep's metadata anchor. No deposit is involved; the
 * wallet pays only the network fee. Non-custodial like register/retire.
 *
 * Requires a live wallet and a reachable Koios provider. Not unit-testable
 * offline; mirrors registerDRep and is covered by the preprod e2e suite.
 */
export async function updateDRepMetadata(opts: RegisterDRepOpts): Promise<{ txHash: string }> {
  const { drepCredential, anchor } = buildRegisterDrepParts({
    drepKeyHash: opts.drepKeyHash,
    anchorUrl: opts.anchorUrl,
    anchorHashHex: opts.anchorHashHex,
  });

  const client = makeClient(opts.network, opts.origin, opts.walletApi);

  const built = await queueUpdateDrepOps(client.newTx(), {
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
 * Derives the delegator's stake credential from a CIP-30 reward address (hex).
 * A reward address is 29 bytes: a header byte then the 28-byte credential. The
 * header high nibble distinguishes a key credential (0b1110) from a script one
 * (0b1111). Returns the SDK Credential plus the raw 28-byte hash, which the
 * builder declares as a required signer so the fee covers the cert witness.
 * Pure; exported for unit tests.
 */
export function stakeCredentialFromRewardAddress(rewardAddressHex: string): {
  stakeCredential: Credential.Credential;
  stakeKeyHash: Uint8Array;
  isScript: boolean;
} {
  const bytes = hexToBytes(rewardAddressHex);
  if (bytes.length !== 29) {
    throw new Error('Unexpected reward address length; expected a 29-byte stake address.');
  }
  const isScript = (bytes[0] >> 4) === 0b1111;
  const hash = bytes.slice(1, 29);
  return {
    stakeCredential: isScript ? Credential.makeScriptHash(hash) : Credential.makeKeyHash(hash),
    stakeKeyHash: hash,
    isScript,
  };
}

/**
 * Builds the DRep vote-delegation target from a DRep credential hash (hex) and
 * whether it is script-controlled. The 28-byte hash is the same credential the
 * dreps table stores (Koios `hex`); script-ness comes from `has_script`.
 * Pure; exported for unit tests.
 */
export function buildDrepTarget(opts: { credentialHex: string; isScript: boolean }): DRep.DRep {
  const bytes = hexToBytes(opts.credentialHex);
  return opts.isScript
    ? DRep.fromScriptHash(ScriptHash.fromBytes(bytes))
    : DRep.fromKeyHash(KeyHash.fromBytes(bytes));
}

/**
 * Queues the vote_deleg certificate, the stake-key required signer, and the
 * CIP-20 attribution tag. Like reg_drep, the vote_deleg certificate is witnessed
 * by a key (the stake key) that controls no input, and EvolutionSDK sizes the fee
 * only for declared signers, so the stake key must be declared via addSigner or
 * the fee falls one vkey witness short.
 */
export function queueDelegateVotesOps(
  txb: DrepTxBuilder,
  parts: { stakeCredential: Credential.Credential; drep: DRep.DRep; stakeKeyHash: Uint8Array },
): DrepTxBuilder {
  return txb
    .delegateToDRep({ stakeCredential: parts.stakeCredential, drep: parts.drep })
    .addSigner({ keyHash: KeyHash.fromBytes(parts.stakeKeyHash) })
    .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() });
}

export interface DelegateVotesOpts {
  /** CIP-30 wallet API obtained from cardano[walletId].enable(). */
  walletApi: WalletApi;
  network: CardanoNetwork;
  /** First reward address (hex) from the connected wallet's getRewardAddresses(). */
  rewardAddressHex: string;
  /** Target DRep credential hash (hex, 28 bytes) from the dreps table. */
  drepCredentialHex: string;
  /** Whether the target DRep is script-controlled (dreps.has_script). */
  drepIsScript: boolean;
  /** window.location.origin, used as the base for the /api/koios proxy. */
  origin: string;
}

/**
 * Builds, signs, and submits a Conway vote_deleg certificate that delegates the
 * connected wallet's voting power to the target DRep.
 *
 * Non-custodial: the wallet signs and submits; the server is never involved in
 * key operations. A CIP-20 attribution tag (label 674) is attached. Requires a
 * live wallet and a reachable Koios provider; covered by the preprod e2e suite.
 *
 * Throws when the wallet's stake credential is script-controlled: that path
 * needs a redeemer rather than a vkey signer and is out of scope here.
 */
export async function delegateVotesToDRep(opts: DelegateVotesOpts): Promise<{ txHash: string }> {
  const { stakeCredential, stakeKeyHash, isScript } = stakeCredentialFromRewardAddress(opts.rewardAddressHex);
  if (isScript) {
    throw new Error('This wallet uses a script-controlled stake credential, which is not supported for delegation.');
  }
  const drep = buildDrepTarget({ credentialHex: opts.drepCredentialHex, isScript: opts.drepIsScript });

  const client = makeClient(opts.network, opts.origin, opts.walletApi);

  const built = await queueDelegateVotesOps(client.newTx(), { stakeCredential, drep, stakeKeyHash }).build();

  const unsignedTxHex = Transaction.toCBORHex(await built.toTransaction());
  const witnessSetHex = await opts.walletApi.signTx(unsignedTxHex, false);
  const signedTxHex = Transaction.addVKeyWitnessesHex(unsignedTxHex, witnessSetHex);
  const txHash = await opts.walletApi.submitTx(signedTxHex);

  return { txHash };
}
