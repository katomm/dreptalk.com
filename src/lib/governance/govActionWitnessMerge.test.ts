// The first Plutus transaction through the island's signing path: the wallet
// signs with signTx(hex, false), its witness set is merged in with
// addVKeyWitnessesHex. The merge must add the vkey witness and leave the
// propose redeemer, the guardrail script and script_data_hash as they were,
// or the ledger rejects the transaction after the deposit prompt.
import { describe, it, expect } from 'vitest';
import { Ed25519Signature, ScriptHash, Transaction, TransactionBody, TransactionWitnessSet, VKey } from '@evolution-sdk/evolution';
import { bytesToHex } from '../crypto/hex.js';
import { GUARDRAIL_SCRIPT_HASH_HEX } from './guardrailScript.js';
import { buildEvalTxHex } from './__fixtures__/evaluateTx.js';

const SCRIPT_DATA_HASH = '5d'.repeat(32);

/** What a CIP-30 wallet's signTx returns: a witness set holding only its vkey witness. */
function walletWitnessSetHex(): string {
  return TransactionWitnessSet.toCBORHex(
    new TransactionWitnessSet.TransactionWitnessSet({
      vkeyWitnesses: [
        new TransactionWitnessSet.VKeyWitness({
          vkey: VKey.fromBytes(new Uint8Array(32).fill(7)),
          signature: Ed25519Signature.fromBytes(new Uint8Array(64).fill(9)),
        }),
      ],
    }),
  );
}

describe('addVKeyWitnessesHex on a guardrail-checked proposal', () => {
  it('adds the vkey witness and keeps the redeemer, the script witness and script_data_hash', () => {
    const unsignedHex = buildEvalTxHex({ scriptDataHashHex: SCRIPT_DATA_HASH });
    const signed = Transaction.fromCBORHex(Transaction.addVKeyWitnessesHex(unsignedHex, walletWitnessSetHex()));

    expect(signed.witnessSet.vkeyWitnesses).toHaveLength(1);
    const redeemers = signed.witnessSet.redeemers?.toArray() ?? [];
    expect(redeemers).toHaveLength(1);
    expect(redeemers[0].tag).toBe('propose');
    expect(redeemers[0].index).toBe(0n);
    expect(redeemers[0].exUnits.mem).toBe(1234n);
    expect(redeemers[0].exUnits.steps).toBe(5678n);
    const scripts = signed.witnessSet.plutusV3Scripts ?? [];
    expect(scripts).toHaveLength(1);
    expect(ScriptHash.toHex(ScriptHash.fromScript(scripts[0]))).toBe(GUARDRAIL_SCRIPT_HASH_HEX);
    expect(signed.body.scriptDataHash ? bytesToHex(signed.body.scriptDataHash.hash) : null).toBe(SCRIPT_DATA_HASH);
  });

  it('leaves the body bytes the wallet signed untouched', () => {
    const unsignedHex = buildEvalTxHex({ scriptDataHashHex: SCRIPT_DATA_HASH });
    const bodyHex = TransactionBody.toCBORHex(Transaction.fromCBORHex(unsignedHex).body);
    expect(unsignedHex).toContain(bodyHex);
    expect(Transaction.addVKeyWitnessesHex(unsignedHex, walletWitnessSetHex())).toContain(bodyHex);
  });
});
