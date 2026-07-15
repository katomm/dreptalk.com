// Client-side builder for the Conway reg_drep transaction.
// Non-custodial: the server never sees a private key; the wallet extension signs and submits.
// Uses EvolutionSDK with our /api/koios proxy to avoid CORS on Koios endpoints.

import {
  Address, Anchor, Client, Credential, DRep, GovernanceAction, KeyHash, ScriptHash,
  Transaction, TransactionHash, Url, UTxO, VotingProcedures, mainnet, preprod,
} from '@evolution-sdk/evolution';
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

// The Conway DRep registration deposit (drep_deposit protocol parameter), in
// lovelace. Stable at 500 ADA on mainnet and preprod; changing it requires an
// on-chain governance action. Used only to size input selection; the SDK reads
// the authoritative value from protocol parameters when balancing the tx.
const DREP_DEPOSIT_LOVELACE = 500_000_000n;

// Headroom over the funded amount to also cover the network fee, the change
// output's min-UTxO, and small protocol-parameter drift, so input selection
// never picks a set that is short by a fee's worth.
const FUNDING_HEADROOM_LOVELACE = 5_000_000n;

/**
 * Collects the connected wallet's UTxOs across all of its addresses, reusing the
 * SDK's own Koios decoding via a read client. Used as the funding universe for
 * input selection and as build({ availableUtxos }).
 */
async function collectWalletUtxos(
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

  // Dedupe by output reference: an address list is normally disjoint, but guard
  // against a wallet returning the same address (and thus UTxO) more than once.
  const byRef = new Map<string, UTxO.UTxO>();
  for (const utxo of perAddress.flat()) {
    byRef.set(UTxO.toOutRefString(utxo), utxo);
  }
  return [...byRef.values()];
}

/** Lovelace in a UTxO (0 if absent), as a bigint for exact comparison. */
function utxoLovelace(utxo: UTxO.UTxO): bigint {
  return BigInt(utxo.assets?.lovelace ?? 0n);
}

/**
 * Picks the fewest wallet UTxOs (largest first) whose combined lovelace covers
 * `minLovelace`, falling back to all UTxOs if the wallet cannot reach it.
 *
 * Why this is needed: these flows build certificate-only transactions with no
 * payment output. The SDK's automatic coin selection is driven by outputs, so
 * with none it selects no inputs and reports "Available: 0" even on a funded
 * wallet, regardless of build({ availableUtxos }). We therefore select inputs
 * ourselves and pass them via collectFrom, sizing the set to cover the
 * certificate deposit (if any) plus a fee headroom. Largest-first keeps the
 * input count, and so the tx size, small.
 */
function pickInputsToCover(utxos: UTxO.UTxO[], minLovelace: bigint): UTxO.UTxO[] {
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

/**
 * Shared tail of every flow here: serialize the built tx, have the wallet
 * sign it, splice the returned witness set in, and submit. The wallet
 * extension performs signing and submission; the server is never involved
 * in key operations.
 */
async function signAndSubmit(
  built: Awaited<ReturnType<DrepTxBuilder['build']>>,
  walletApi: WalletApi,
): Promise<{ txHash: string }> {
  const unsignedTxHex = Transaction.toCBORHex(await built.toTransaction());
  const witnessSetHex = await walletApi.signTx(unsignedTxHex, false);
  const signedTxHex = Transaction.addVKeyWitnessesHex(unsignedTxHex, witnessSetHex);
  const txHash = await walletApi.submitTx(signedTxHex);
  return { txHash };
}

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
  const availableUtxos = await collectWalletUtxos(opts.network, opts.origin, opts.walletApi);
  // reg_drep locks the DRep deposit, so the inputs must cover deposit + fee.
  const inputs = pickInputsToCover(availableUtxos, DREP_DEPOSIT_LOVELACE + FUNDING_HEADROOM_LOVELACE);

  const built = await queueRegisterDrepOps(client.newTx(), {
    drepCredential,
    anchor,
    drepKeyHash: opts.drepKeyHash,
  })
    .collectFrom({ inputs })
    .build({ availableUtxos });

  return signAndSubmit(built, opts.walletApi);
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
  const availableUtxos = await collectWalletUtxos(opts.network, opts.origin, opts.walletApi);
  // unreg_drep refunds the deposit, so the inputs only need to cover the fee.
  const inputs = pickInputsToCover(availableUtxos, FUNDING_HEADROOM_LOVELACE);

  const built = await queueDeregisterDrepOps(client.newTx(), {
    drepCredential,
    drepKeyHash: opts.drepKeyHash,
  })
    .collectFrom({ inputs })
    .build({ availableUtxos });

  return signAndSubmit(built, opts.walletApi);
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
  const availableUtxos = await collectWalletUtxos(opts.network, opts.origin, opts.walletApi);
  // update_drep has no deposit, so the inputs only need to cover the fee.
  const inputs = pickInputsToCover(availableUtxos, FUNDING_HEADROOM_LOVELACE);

  const built = await queueUpdateDrepOps(client.newTx(), {
    drepCredential,
    anchor,
    drepKeyHash: opts.drepKeyHash,
  })
    .collectFrom({ inputs })
    .build({ availableUtxos });

  return signAndSubmit(built, opts.walletApi);
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
 * Parses the stored governance action id ("<txHash>#<index>", the
 * governance_actions.id form) into the SDK GovActionId the vote builder needs.
 * The tx hash is 64 lowercase hex chars (32 bytes); the index is a uint16.
 * Pure; exported for unit tests.
 */
export function buildGovActionId(id: string): GovernanceAction.GovActionId {
  const m = /^([0-9a-fA-F]{64})#(\d{1,5})$/.exec(id.trim());
  if (!m) {
    throw new Error('Invalid governance action id; expected "<64-hex-txHash>#<index>".');
  }
  const index = Number(m[2]);
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) {
    throw new Error('Governance action index out of range.');
  }
  return new GovernanceAction.GovActionId({
    transactionId: TransactionHash.fromHex(m[1].toLowerCase()),
    govActionIndex: BigInt(index),
  });
}

/** Maps our vote string to the SDK Vote value. */
function voteValue(vote: 'yes' | 'no' | 'abstain') {
  return vote === 'yes' ? VotingProcedures.yes() : vote === 'no' ? VotingProcedures.no() : VotingProcedures.abstain();
}

/**
 * Queues one voting-procedures op carrying ALL of this DRep's votes, the
 * DRep-key required signer, and the CIP-20 attribution tag. All votes MUST go
 * through a single multiVote call: the SDK merges repeated .vote() calls by
 * object identity, which can emit duplicate CBOR map keys for value-equal
 * voter or action ids. Pure (no network); exported for unit tests.
 */
export function queueVotesOps(
  txb: DrepTxBuilder,
  parts: {
    drepKeyHash: Uint8Array;
    votes: Array<{
      govActionId: GovernanceAction.GovActionId;
      vote: 'yes' | 'no' | 'abstain';
      anchor: Anchor.Anchor | null;
    }>;
  },
): DrepTxBuilder {
  if (parts.votes.length === 0) {
    throw new Error('At least one vote is required.');
  }
  const voter = new VotingProcedures.DRepVoter({
    drep: DRep.fromKeyHash(KeyHash.fromBytes(parts.drepKeyHash)),
  });
  const votingProcedures = VotingProcedures.multiVote(
    voter,
    parts.votes.map((v): [GovernanceAction.GovActionId, VotingProcedures.VotingProcedure] => [
      v.govActionId,
      new VotingProcedures.VotingProcedure({ vote: voteValue(v.vote), anchor: v.anchor }),
    ]),
  );

  return txb
    .vote({ votingProcedures })
    .addSigner({ keyHash: KeyHash.fromBytes(parts.drepKeyHash) })
    .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() });
}

export interface DRepVoteInput {
  /** Stored governance action id, "<txHash>#<index>". */
  govActionId: string;
  vote: 'yes' | 'no' | 'abstain';
  /** Hosted rationale URL from POST /api/vote/rationale; omit for no rationale. */
  anchorUrl?: string;
  /** 64-char blake2b-256 hex paired with anchorUrl. */
  anchorHashHex?: string;
}

export interface CastDRepVotesOpts {
  /** CIP-30 wallet API obtained from cardano[walletId].enable(). */
  walletApi: WalletApi;
  network: CardanoNetwork;
  /** 28-byte blake2b-224 of the CIP-95 DRep verification key. */
  drepKeyHash: Uint8Array;
  votes: DRepVoteInput[];
  /** window.location.origin, base for the /api/koios proxy. */
  origin: string;
}

/**
 * Builds, signs, and submits ONE Conway vote transaction casting the connected
 * DRep's votes on one or more governance actions. Each vote carries its own
 * optional rationale anchor. One DRep signature covers all votes. Ledger
 * semantics are all-or-nothing: if any targeted action is no longer active at
 * submit time the whole transaction is rejected. Non-custodial: the wallet
 * signs and submits. Requires a live wallet and a reachable Koios provider;
 * validation up to the duplicate check is unit-tested offline.
 */
export async function castDRepVotes(opts: CastDRepVotesOpts): Promise<{ txHash: string }> {
  if (opts.votes.length === 0) {
    throw new Error('At least one vote is required.');
  }
  const seen = new Set<string>();
  const votes = opts.votes.map((v) => {
    const key = v.govActionId.trim().toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate governance action in batch: ${v.govActionId}`);
    }
    seen.add(key);
    return {
      govActionId: buildGovActionId(v.govActionId),
      vote: v.vote,
      anchor:
        v.anchorUrl && v.anchorHashHex
          ? new Anchor.Anchor({
              anchorUrl: new Url.Url({ href: v.anchorUrl }),
              anchorDataHash: hexToBytes(v.anchorHashHex),
            })
          : null,
    };
  });

  const client = makeClient(opts.network, opts.origin, opts.walletApi);
  const availableUtxos = await collectWalletUtxos(opts.network, opts.origin, opts.walletApi);
  // Votes carry no deposit, so the inputs only need to cover the fee.
  const inputs = pickInputsToCover(availableUtxos, FUNDING_HEADROOM_LOVELACE);

  const built = await queueVotesOps(client.newTx(), { drepKeyHash: opts.drepKeyHash, votes })
    .collectFrom({ inputs })
    .build({ availableUtxos });

  return signAndSubmit(built, opts.walletApi);
}

export interface CastDRepVoteOpts {
  /** CIP-30 wallet API obtained from cardano[walletId].enable(). */
  walletApi: WalletApi;
  network: CardanoNetwork;
  /** 28-byte blake2b-224 of the CIP-95 DRep verification key. */
  drepKeyHash: Uint8Array;
  /** Stored governance action id, "<txHash>#<index>". */
  govActionId: string;
  vote: 'yes' | 'no' | 'abstain';
  /** Hosted rationale URL from POST /api/vote/rationale; omit for no rationale. */
  anchorUrl?: string;
  /** 64-char blake2b-256 hex paired with anchorUrl. */
  anchorHashHex?: string;
  /** window.location.origin, base for the /api/koios proxy. */
  origin: string;
}

/**
 * Builds, signs, and submits a Conway vote transaction casting the connected
 * DRep's vote on one governance action. Non-custodial: the wallet signs and
 * submits. A CIP-20 attribution tag (label 674) is attached. No deposit, so the
 * inputs only need to cover the fee. Requires a live wallet and a reachable
 * Koios provider; not covered by offline unit tests.
 */
export async function castDRepVote(opts: CastDRepVoteOpts): Promise<{ txHash: string }> {
  return castDRepVotes({
    walletApi: opts.walletApi,
    network: opts.network,
    drepKeyHash: opts.drepKeyHash,
    origin: opts.origin,
    votes: [
      {
        govActionId: opts.govActionId,
        vote: opts.vote,
        anchorUrl: opts.anchorUrl,
        anchorHashHex: opts.anchorHashHex,
      },
    ],
  });
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
  const availableUtxos = await collectWalletUtxos(opts.network, opts.origin, opts.walletApi);
  // vote_deleg has no deposit, so the inputs only need to cover the fee.
  const inputs = pickInputsToCover(availableUtxos, FUNDING_HEADROOM_LOVELACE);

  const built = await queueDelegateVotesOps(client.newTx(), { stakeCredential, drep, stakeKeyHash })
    .collectFrom({ inputs })
    .build({ availableUtxos });

  return signAndSubmit(built, opts.walletApi);
}
