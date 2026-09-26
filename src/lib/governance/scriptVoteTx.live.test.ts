// LIVE preprod e2e (gated, see __fixtures__/liveWallet.ts for the wallet it
// needs). It needs outbound network to preprod Koios, so it is NOT a CI test,
// the deterministic conversion guard lives in scriptVoteTx.test.ts. This test
// SUBMITS a real vote transaction on preprod. Run it with
// `npm run test:live:submit`.
//
// It reproduces the proven native-script vote flow (preprod tx d20239...):
//   1. Build a native-script DRep vote tx where the voter credential is a script
//      hash, the script is attached, and there is NO addSigner and NO redeemer.
//   2. Produce the member witness by signing the tx BODY HASH with the ed25519
//      DRep key directly (the cardano-signer / raw-key path), NOT via the wallet.
//   3. Fold the witness in and submit; assert a 64-hex tx hash.
//
// The native script used is an any-of-one over the test wallet's own DRep key,
// so the script hash defines the scriptDrepId and the single member witness
// satisfies it. This needs no external script fixture.
import { describe, it, expect } from 'vitest';
import {
  Address,
  DRep,
  Ed25519Signature,
  NativeScripts,
  ScriptHash,
  TransactionWitnessSet,
  VKey,
} from '@evolution-sdk/evolution';
import { LIVE, PREPROD_KOIOS, loadDrepKey } from './__fixtures__/liveWallet.js';
import { bytesToHex } from '../crypto/hex.js';
import type { NativeScript } from '../cardano/nativeScript.js';
import type { WalletApi } from './drepTx.js';
import { assembleScriptVoteTx, buildScriptDRepVoteTx } from './scriptVoteTx.js';

const ORIGIN = 'https://preprod.dreptalk.com';


// A read-only wallet adapter over the test wallet: getUtxos/getUsedAddresses for
// funding, submitTx for submission. signTx/signData are unused on the native-script
// path (member witnesses are produced from the body hash), so they throw.
function makeReadWallet(paymentAddress: string): WalletApi {
  const addressHex = bytesToHex(Address.toBytes(Address.fromBech32(paymentAddress)));
  return {
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
    async signTx() {
      throw new Error('signTx is not used on the native-script vote path');
    },
    async signData() {
      throw new Error('signData is not used on the native-script vote path');
    },
    async submitTx(txCborHex: string) {
      // Submit the assembled tx straight to Koios (the read client has no submit;
      // a real flow submits via the CIP-30 wallet). Koios returns the tx hash.
      const res = await fetch(`${PREPROD_KOIOS}/submittx`, {
        method: 'POST',
        headers: { 'content-type': 'application/cbor' },
        body: hexBytes(txCborHex) as BodyInit,
      });
      if (!res.ok) throw new Error(`Koios submittx failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as string;
    },
  };
}

// Build a member witness set hex by signing the tx body hash with the DRep key,
// exactly as the cardano-signer paste path does off-band.
function memberWitnessHex(opts: {
  pubKey: Uint8Array;
  bodyHashHex: string;
  sign: (m: Uint8Array) => Uint8Array;
}): string {
  const sigBytes = opts.sign(hexBytes(opts.bodyHashHex));
  const witness = new TransactionWitnessSet.VKeyWitness({
    vkey: VKey.fromBytes(opts.pubKey),
    signature: Ed25519Signature.fromBytes(sigBytes),
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
  it('builds, assembles from a member witness, and submits a native-script DRep vote', async () => {
    const { paymentAddress, pubKey, keyHash, sign } = loadDrepKey();

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

    const walletApi = makeReadWallet(paymentAddress);

    const { unsignedTxHex, bodyHashHex } = await buildScriptDRepVoteTx({
      walletApi,
      network: 'preprod',
      scriptDrepId,
      nativeScript,
      govActionId,
      vote: 'abstain',
      origin: ORIGIN,
    });
    expect(unsignedTxHex).toMatch(/^[0-9a-f]+$/);
    expect(bodyHashHex).toMatch(/^[0-9a-f]{64}$/);

    const witnessHex = memberWitnessHex({ pubKey, bodyHashHex, sign });

    const { txHash } = await assembleScriptVoteTx({
      unsignedTxHex,
      witnessHexes: [witnessHex],
      network: 'preprod',
      origin: ORIGIN,
      walletApi,
    });
    expect(txHash).toMatch(/^[0-9a-f]{64}$/);
  }, 90_000);
});
