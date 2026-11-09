// The transaction codec of the group signing link, pure and without I/O: decoding an unsigned
// group transaction, the witness set splice of its assembly, and reading its payload's events.
import { Transaction, TransactionBody, TransactionHash, TransactionWitnessSet } from '@evolution-sdk/evolution';
import { type ChainTx, type DecodedPayload, decodePayload, decodeTransaction, type GroupEvent, inspectTransaction, type TxFacts } from 'drep-groups';
import { decodeBech32 } from '../crypto/bech32.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';
import type { PendingWitness } from '../db/pendingMultisigTx.js';
import { parseWitnessSetHex, vkeyWitnessOf } from '../governance/multisigWitness.js';

export interface DecodedGroupTx {
  bytes: Uint8Array;
  facts: TxFacts;
  chain: ChainTx;
  decoded: DecodedPayload | null;
  /** Lowercase hex blake2b-256 of the body bytes as they are, the tx hash. */
  bodyHash: string;
  inputs: Array<{ txHash: string; index: number }>;
}

/** Decodes an unsigned group transaction. Throws on anything that is not a well formed Conway transaction. */
export function decodeGroupTx(hex: string): DecodedGroupTx {
  const bytes = hexToBytes(hex);
  const facts = inspectTransaction(bytes);
  const tx = Transaction.fromCBORHex(hex);
  // The hash of the original body bytes, a re-encoded body could hash differently.
  const bodyHash = TransactionHash.toHex(TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(bytes))).toLowerCase();
  const chain = decodeTransaction(bytes, { txHash: bodyHash, blockHeight: 0, txIndex: 0 });
  if (chain.invalidHereafter !== (tx.body.ttl ?? null)) throw new Error('validity end read differently');
  const inputs = tx.body.inputs.map((i) => ({ txHash: TransactionHash.toHex(i.transactionId).toLowerCase(), index: Number(i.index) }));
  return { bytes, facts, chain, decoded: chain.payload ? decodePayload(chain.payload) : null, bodyHash, inputs };
}

// The definite four element array head of a transaction and the empty witness set of an unsigned
// DRepTalk group transaction, no scripts attached. The witness splice relies on both being one byte.
const TX_ARRAY_HEAD = 0x84;
const EMPTY_WITNESS_SET = 0xa0;

/** Offset of the witness set, null unless the tx is a one byte array head followed by the body. */
function witnessSetOffset(bytes: Uint8Array): number | null {
  if (bytes[0] !== TX_ARRAY_HEAD) return null;
  return 1 + Transaction.extractBodyBytes(bytes).length;
}

/** Why the unsigned transaction cannot take spliced witnesses, null when it can. */
export function unsignedShapeError(tx: DecodedGroupTx): string | null {
  const at = witnessSetOffset(tx.bytes);
  if (at === null) return 'transaction must be a definite four element array';
  return tx.bytes[at] === EMPTY_WITNESS_SET ? null : 'transaction must carry no witnesses';
}

/**
 * The unsigned transaction with the stored vkey witnesses in its witness set. The body and the
 * metadata bytes are kept as they are, so the tx hash stays the body hash the witnesses signed.
 */
export function assembleTx(unsignedHex: string, witnesses: PendingWitness[]): string {
  const bytes = hexToBytes(unsignedHex);
  const bodyEnd = witnessSetOffset(bytes);
  if (bodyEnd === null || bytes[bodyEnd] !== EMPTY_WITNESS_SET) throw new Error('unsigned transaction is not a plain unsigned array');
  const vkeys = witnesses.flatMap((w) => parseWitnessSetHex(w.witness_hex).map(vkeyWitnessOf));
  const set = hexToBytes(TransactionWitnessSet.toCBORHex(TransactionWitnessSet.fromVKeyWitnesses(vkeys)));
  return bytesToHex(Uint8Array.from([...bytes.subarray(0, bodyEnd), ...set, ...bytes.subarray(bodyEnd + 1)]));
}

/** The seq of the control event of a payload, null without one. */
export function controlSeq(decoded: DecodedPayload | null): bigint | null {
  for (const e of decoded?.events ?? []) {
    if (e.ok && (e.event.tag === 'update' || e.event.tag === 'dissolve')) return e.event.seq;
  }
  return null;
}

/** The events of a decoded payload that read, in order. */
export const eventsOf = (decoded: DecodedPayload | null): GroupEvent[] => (decoded?.events ?? []).flatMap((e) => (e.ok ? [e.event] : []));

/** The payment key hash of a Shelley address, null for a script payment credential or anything else. */
export function paymentKeyHash(address: string): string | null {
  try {
    const { prefix, data } = decodeBech32(address);
    if (prefix !== 'addr' && prefix !== 'addr_test') return null;
    const type = data[0] >> 4;
    if (type > 7 || type % 2 !== 0 || data.length < 29) return null;
    return bytesToHex(data.subarray(1, 29));
  } catch {
    return null;
  }
}
