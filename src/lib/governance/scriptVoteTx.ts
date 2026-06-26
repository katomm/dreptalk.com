// Client-side builder for a native-script (multisig) DRep vote transaction.
//
// Unlike the key-DRep vote in drepTx.ts, the voter credential here is a script
// hash, not a key hash: the vote is authorized by attaching the native script and
// collecting enough member vkey witnesses to satisfy it. We deliberately do NOT
// declare the script members as required signers (no addSigner) and add NO
// redeemer (native scripts have none; the SDK is patched to allow a native-script
// voter without one). The members each sign the tx body hash off-band and their
// witness sets are folded in during assembly.
//
// Split into two phases so the collected witnesses can arrive from different
// sources/sessions: buildScriptDRepVoteTx returns the unsigned tx + body hash;
// assembleScriptVoteTx merges the witness sets and submits.

import {
  Address,
  Anchor,
  Client,
  DRep,
  NativeScripts,
  ScriptHash,
  Transaction,
  TransactionBody,
  TransactionHash,
  Url,
  UTxO,
  VotingProcedures,
  mainnet,
  preprod,
} from '@evolution-sdk/evolution';
import { dreptalkCip20Metadatum, DREPTALK_CIP20_LABEL } from '../cardano/tx.js';
import type { NativeScript } from '../cardano/nativeScript.js';
import { parseDrepId } from '../cardano/identity.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';
import type { CardanoNetwork } from '../config/network.js';
import { type WalletApi, buildGovActionId } from './drepTx.js';

// Headroom over the funded amount to cover the network fee, the change output's
// min-UTxO, and small protocol-parameter drift, so input selection never picks a
// set that is short by a fee's worth. A vote tx has no deposit; the inputs only
// need to cover the fee. Mirrors FUNDING_HEADROOM_LOVELACE in drepTx.ts.
const FUNDING_HEADROOM_LOVELACE = 5_000_000n;

/**
 * Recursively converts our parsed NativeScript JSON into an SDK NativeScript.
 *
 * The SDK's container constructors (makeScriptAll/Any/NOfK) take the inner
 * NativeScriptVariants shape, while ScriptHash.fromScript and attachScript take
 * the top-level NativeScript wrapper. We therefore return the wrapper and unwrap
 * children via `.script` when recursing. Our `after` (a lower slot bound) maps to
 * invalid_before; our `before` (an upper bound) maps to invalid_hereafter.
 */
export function nativeScriptToSdk(s: NativeScript): NativeScripts.NativeScript {
  switch (s.type) {
    case 'sig':
      return NativeScripts.makeScriptPubKey(hexToBytes(s.keyHash));
    case 'all':
      return NativeScripts.makeScriptAll(s.scripts.map((c) => nativeScriptToSdk(c).script));
    case 'any':
      return NativeScripts.makeScriptAny(s.scripts.map((c) => nativeScriptToSdk(c).script));
    case 'atLeast':
      return NativeScripts.makeScriptNOfK(BigInt(s.required), s.scripts.map((c) => nativeScriptToSdk(c).script));
    case 'after':
      return NativeScripts.makeInvalidBefore(BigInt(s.slot));
    case 'before':
      return NativeScripts.makeInvalidHereafter(BigInt(s.slot));
  }
}

/** Maps our vote string to the SDK Vote value. */
function voteValue(vote: 'yes' | 'no' | 'abstain') {
  return vote === 'yes' ? VotingProcedures.yes() : vote === 'no' ? VotingProcedures.no() : VotingProcedures.abstain();
}

/**
 * Builds the EvolutionSDK client wired to the network, our Koios proxy, and the
 * connected CIP-30 wallet. Mirrors makeClient in drepTx.ts so both flows use the
 * identical provider setup.
 */
function makeClient(network: CardanoNetwork, origin: string, walletApi: WalletApi) {
  return Client.make(network === 'mainnet' ? mainnet : preprod)
    .withKoios({ baseUrl: `${origin}/api/koios` })
    .withCip30(walletApi);
}

/**
 * Collects the connected wallet's UTxOs across all of its addresses via a read
 * client. Replicates collectWalletUtxos from drepTx.ts (not exported there); the
 * pattern is the proven funding universe for these certificate/vote-only txs.
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

  // Dedupe by output reference in case a wallet returns the same address twice.
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
 * Replicates pickInputsToCover from drepTx.ts: a vote-only tx has no payment
 * output to drive the SDK's automatic coin selection, so we select inputs
 * ourselves and pass them via collectFrom.
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

export interface BuildScriptVoteOpts {
  /** CIP-30 wallet API of the member building (and funding) the tx. */
  walletApi: WalletApi;
  network: CardanoNetwork;
  /** The script DRep's bech32 id (CIP-129); its hash must equal the script's. */
  scriptDrepId: string;
  /** The native script controlling the DRep, parsed from cardano-cli/Koios JSON. */
  nativeScript: NativeScript;
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
 * Builds the unsigned native-script DRep vote tx: a script-credential voter, the
 * attached native script, the CIP-20 attribution tag, and the builder's wallet
 * inputs for the fee. Returns the unsigned tx hex and the body hash that each
 * member signs to produce their vkey witness.
 *
 * No addSigner (the members are not required signers) and no redeemer (native
 * scripts have none). Defense in depth: the derived script hash is checked
 * against the credential encoded in scriptDrepId before building.
 *
 * Requires a live wallet and a reachable Koios provider; the pure conversion is
 * covered by scriptVoteTx.test.ts and the full flow by scriptVoteTx.live.test.ts.
 */
export async function buildScriptDRepVoteTx(
  opts: BuildScriptVoteOpts,
): Promise<{ unsignedTxHex: string; bodyHashHex: string }> {
  const script = nativeScriptToSdk(opts.nativeScript);
  const scriptHash = ScriptHash.fromScript(script);
  const scriptHashHex = bytesToHex(ScriptHash.toBytes(scriptHash));

  const parsed = parseDrepId(opts.scriptDrepId);
  if (parsed?.kind !== 'script') {
    throw new Error('scriptDrepId is not a valid script DRep id.');
  }
  if (parsed.hashHex !== scriptHashHex) {
    throw new Error('The native script does not match the script DRep credential.');
  }

  const anchor =
    opts.anchorUrl && opts.anchorHashHex
      ? new Anchor.Anchor({
          anchorUrl: new Url.Url({ href: opts.anchorUrl }),
          anchorDataHash: hexToBytes(opts.anchorHashHex),
        })
      : null;

  const voter = new VotingProcedures.DRepVoter({ drep: DRep.fromScriptHash(scriptHash) });
  const procedure = new VotingProcedures.VotingProcedure({ vote: voteValue(opts.vote), anchor });
  const votingProcedures = VotingProcedures.singleVote(voter, buildGovActionId(opts.govActionId), procedure);

  const client = makeClient(opts.network, opts.origin, opts.walletApi);
  const availableUtxos = await collectWalletUtxos(opts.network, opts.origin, opts.walletApi);
  const inputs = pickInputsToCover(availableUtxos, FUNDING_HEADROOM_LOVELACE);

  const built = await client
    .newTx()
    .vote({ votingProcedures })
    .attachScript({ script })
    .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() })
    .collectFrom({ inputs })
    .build({ availableUtxos });

  const tx = await built.toTransaction();
  const unsignedTxHex = Transaction.toCBORHex(tx);
  const bodyHashHex = bytesToHex(TransactionHash.toBytes(TransactionBody.toHash(tx.body)));
  return { unsignedTxHex, bodyHashHex };
}

export interface AssembleScriptVoteArgs {
  /** The unsigned tx hex from buildScriptDRepVoteTx. */
  unsignedTxHex: string;
  /** One vkey-witness-set hex per collected member (and the funding wallet). */
  witnessHexes: string[];
  network: CardanoNetwork;
  origin: string;
  walletApi: WalletApi;
}

/**
 * Folds every collected vkey witness set into the unsigned tx and submits it via
 * the wallet. Uses the same Transaction.addVKeyWitnessesHex helper the key-vote
 * path uses, applied once per witness set. Returns the submitted tx hash.
 */
export async function assembleScriptVoteTx(args: AssembleScriptVoteArgs): Promise<{ txHash: string }> {
  let assembledHex = args.unsignedTxHex;
  for (const witnessHex of args.witnessHexes) {
    assembledHex = Transaction.addVKeyWitnessesHex(assembledHex, witnessHex);
  }
  const txHash = await args.walletApi.submitTx(assembledHex);
  return { txHash };
}
