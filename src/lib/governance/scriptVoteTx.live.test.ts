// LIVE preprod e2e (gated, see __fixtures__/liveWallet.ts for the wallet it
// needs). It needs outbound network to preprod Koios, so it is NOT a CI test,
// the deterministic conversion guard lives in scriptVoteTx.test.ts. Run it with
// `npm run test:live:script-vote`.
//
// It walks the native-script vote flow of the multisig panel against real
// preprod funding, and stops before submitting:
//   1. Build a native-script DRep vote tx where the voter credential is a script
//      hash, the script is attached, and there is NO addSigner and NO redeemer.
//   2. Produce the member witness by signing the tx BODY HASH with the ed25519
//      DRep key directly (the cardano-signer / raw-key path), NOT via the wallet.
//   3. Fold the witness in with assembleScriptVoteTx, add the funding witness
//      the way the panel's partial signTx does, and check every signature.
//
// The native script is an any-of-one over the test wallet's own DRep key. Its
// script DRep is not registered on preprod, and registering one would make a
// second DRep for the shared test wallet, so the ledger would reject the vote.
// The test therefore never submits: submitTx on its wallet adapter throws.
import { describe, it, expect } from 'vitest';
import {
  Address,
  DRep,
  Ed25519Signature,
  NativeScripts,
  ScriptHash,
  Transaction,
  TransactionBody,
  TransactionHash,
  TransactionWitnessSet,
  VKey,
} from '@evolution-sdk/evolution';
import { LIVE, PREPROD_KOIOS, loadDrepKey, loadPaymentKey } from './__fixtures__/liveWallet.js';
import { bytesToHex } from '../crypto/hex.js';
import { verifyEd25519 } from '../crypto/ed25519.js';
import type { NativeScript } from '../cardano/nativeScript.js';
import type { WalletApi } from './drepTx.js';
import { assembleScriptVoteTx, buildScriptDRepVoteTx } from './scriptVoteTx.js';

const ORIGIN = 'https://preprod.dreptalk.com';

type Signer = { pubKey: Uint8Array; sign: (m: Uint8Array) => Uint8Array };

// A wallet adapter over the test wallet: getUsedAddresses for funding and a
// payment key signTx like the panel's partial sign. submitTx records the tx
// and throws, so nothing ever reaches the chain.
function makeWallet(paymentAddress: string, payment: Signer) {
  const addressHex = bytesToHex(Address.toBytes(Address.fromBech32(paymentAddress)));
  const submitted: string[] = [];
  const api: WalletApi = {
    async getUsedAddresses() {
      return [addressHex];
    },
    async getUnusedAddresses() {
      return [];
    },
    async getRewardAddresses() {
      return [];
    },
    async getUtxos() {
      // buildScriptDRepVoteTx collects UTxOs via its own Koios client from the
      // addresses getUsedAddresses returns, so this CIP-30 accessor is unused on
      // this path; return empty rather than re-serialize SDK UTxOs to CBOR.
      return [];
    },
    async signTx(txHex: string) {
      return witnessSetHex(payment, bodyHashOf(txHex));
    },
    async signData() {
      throw new Error('signData is not used on the native-script vote path');
    },
    async submitTx(txCborHex: string) {
      submitted.push(txCborHex);
      throw new Error('this test never submits');
    },
  };
  return { api, submitted };
}

function bodyHashOf(txHex: string): string {
  return bytesToHex(TransactionHash.toBytes(TransactionBody.toHash(Transaction.fromCBORHex(txHex).body)));
}

// Build a witness set hex by signing the tx body hash with one key, exactly as
// the cardano-signer paste path does off-band.
function witnessSetHex(key: Signer, bodyHashHex: string): string {
  const witness = new TransactionWitnessSet.VKeyWitness({
    vkey: VKey.fromBytes(key.pubKey),
    signature: Ed25519Signature.fromBytes(key.sign(hexBytes(bodyHashHex))),
  });
  const set = new TransactionWitnessSet.TransactionWitnessSet({ vkeyWitnesses: [witness] });
  return TransactionWitnessSet.toCBORHex(set);
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe.skipIf(!LIVE)('LIVE preprod script-vote e2e', () => {
  it('builds a native-script DRep vote, folds in the member and funding witnesses, and every signature holds', async () => {
    const { paymentAddress, pubKey, keyHash, sign } = loadDrepKey();
    const payment = loadPaymentKey();

    // any-of-one native script over the wallet's own DRep key hash.
    const nativeScript: NativeScript = { type: 'any', scripts: [{ type: 'sig', keyHash: bytesToHex(keyHash) }] };

    // Derive the matching script DRep id from the script hash.
    const sdkScript = NativeScripts.makeScriptPubKey(keyHash);
    const anyScript = NativeScripts.makeScriptAny([sdkScript.script]);
    const scriptHash = ScriptHash.fromScript(anyScript);
    const scriptDrepId = DRep.toBech32(DRep.fromScriptHash(scriptHash));

    // Pick a currently-votable preprod governance action.
    const list = (await (await fetch(`${PREPROD_KOIOS}/proposal_list?limit=200`)).json()) as Array<{
      proposal_tx_hash: string;
      proposal_index: number;
      ratified_epoch: number | null;
      enacted_epoch: number | null;
      dropped_epoch: number | null;
      expired_epoch: number | null;
    }>;
    const active = list.find(
      (p) => !p.ratified_epoch && !p.enacted_epoch && !p.dropped_epoch && !p.expired_epoch,
    );
    expect(active, 'no active preprod proposal to vote on').toBeTruthy();
    const govActionId = `${active!.proposal_tx_hash}#${active!.proposal_index}`;

    const wallet = makeWallet(paymentAddress, payment);

    const { unsignedTxHex, bodyHashHex } = await buildScriptDRepVoteTx({
      walletApi: wallet.api,
      network: 'preprod',
      scriptDrepId,
      nativeScript,
      govActionId,
      vote: 'abstain',
      origin: ORIGIN,
    });
    expect(unsignedTxHex).toMatch(/^[0-9a-f]+$/);
    expect(bodyHashHex).toMatch(/^[0-9a-f]{64}$/);

    // assembleScriptVoteTx folds the member witness in and hands the tx to
    // submitTx, which records it and throws.
    await expect(
      assembleScriptVoteTx({
        unsignedTxHex,
        witnessHexes: [witnessSetHex({ pubKey, sign }, bodyHashHex)],
        network: 'preprod',
        origin: ORIGIN,
        walletApi: wallet.api,
      }),
    ).rejects.toThrow('this test never submits');
    expect(wallet.submitted).toHaveLength(1);
    const assembledHex = wallet.submitted[0];

    // The funding witness, as the multisig panel adds it before its submit.
    const finalHex = Transaction.addVKeyWitnessesHex(assembledHex, await wallet.api.signTx(assembledHex, true));
    const finalTx = Transaction.fromCBORHex(finalHex);

    expect(bodyHashOf(finalHex)).toBe(bodyHashHex);
    expect(finalTx.witnessSet.nativeScripts ?? []).toHaveLength(1);
    expect(finalTx.witnessSet.redeemers).toBeUndefined();

    const witnesses = finalTx.witnessSet.vkeyWitnesses ?? [];
    const signers = witnesses.map((w) => bytesToHex(VKey.toBytes(w.vkey))).sort();
    expect(signers).toEqual([bytesToHex(pubKey), bytesToHex(payment.pubKey)].sort());
    for (const w of witnesses) {
      const result = await verifyEd25519(
        Ed25519Signature.toBytes(w.signature),
        hexBytes(bodyHashHex),
        VKey.toBytes(w.vkey),
      );
      expect(result.ok).toBe(true);
    }
  }, 90_000);
});
