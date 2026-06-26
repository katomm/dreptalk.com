// LIVE preprod e2e (gated). Skipped unless DREPTALK_LIVE=1, because it needs
// outbound network to preprod Koios and the preprod test wallet (mnemonic at
// ~/Sites/dreptalk-planning/test-wallet/wallet.json, outside this repo). It is
// NOT a CI test; the deterministic conversion guard lives in scriptVoteTx.test.ts.
// Run it with: DREPTALK_LIVE=1 npx vitest run src/lib/governance/scriptVoteTx.live.test.ts
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
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as E from '@evolution-sdk/evolution';
import {
  Address,
  DRep,
  Ed25519Signature,
  NativeScripts,
  ScriptHash,
  TransactionWitnessSet,
  VKey,
} from '@evolution-sdk/evolution';
import { blake2b224 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import type { NativeScript } from '../cardano/nativeScript.js';
import type { WalletApi } from './drepTx.js';
import { assembleScriptVoteTx, buildScriptDRepVoteTx } from './scriptVoteTx.js';

const LIVE = process.env.DREPTALK_LIVE === '1';
const KOIOS = 'https://preprod.koios.rest/api/v1';
const ORIGIN = 'https://preprod.dreptalk.com';
const WALLET_PATH = `${homedir()}/Sites/dreptalk-planning/test-wallet/wallet.json`;

// Derive the DRep signing material from the test wallet (role 3, index 0).
function loadDrepKey() {
  const w = JSON.parse(readFileSync(WALLET_PATH, 'utf8')) as { mnemonic: string; paymentAddress: string };
  const entropy = mnemonicToEntropy(w.mnemonic, wordlist);
  const root = E.Bip32PrivateKey.fromBip39Entropy(entropy, '');
  const prv = E.Bip32PrivateKey.toPrivateKey(E.Bip32PrivateKey.derivePath(root, "1852'/1815'/0'/3/0"));
  const pubKey = E.VKey.toBytes(E.PrivateKey.toPublicKey(prv));
  const sign = (msg: Uint8Array) => E.Ed25519Signature.toBytes(E.PrivateKey.sign(prv, msg));
  return { paymentAddress: w.paymentAddress, pubKey, keyHash: blake2b224(pubKey), sign };
}

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
      const res = await fetch(`${KOIOS}/submittx`, {
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
    const list = (await (await fetch(`${KOIOS}/proposal_list?limit=200`)).json()) as Array<{
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
