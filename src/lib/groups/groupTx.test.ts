// Offline tests of the group transaction builder: the real Evolution builder runs against a fake
// CIP-30 wallet, fixed protocol parameters and fixed UTxOs, so no provider is ever asked.
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  Address,
  Assets,
  Client,
  Ed25519Signature,
  Transaction,
  TransactionHash,
  TransactionWitnessSet,
  UTxO,
  VKey,
  preprod,
} from '@evolution-sdk/evolution';
import { encodePayload, majorityScript } from 'drep-groups';
import { describe, expect, it } from 'vitest';
import { blake2b224 } from '../crypto/blake.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';
import type { PendingWitness } from '../db/pendingMultisigTx.js';
import type { DrepTxBuilder, WalletApi } from '../governance/drepTx.js';
import { assembleTx, decodeGroupTx, unsignedShapeError } from './actionTx.js';
import { ACTION_TTL_SECONDS, WITNESS_FEE_BYTES } from './constants.js';
import {
  buildGroupTxFrom,
  buildSendToSelfFrom,
  feeHeadroomKeys,
  keyPaymentUtxos,
  queueGroupOps,
  withoutInputs,
  withWitnessHeadroom,
} from './groupTx.js';
import { FUNDS_HELD } from './view.js';

const PARAMS = {
  minFeeA: 44,
  minFeeB: 155_381,
  maxTxSize: 16_384,
  maxValSize: 5000,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
  govActionDeposit: 100_000_000_000n,
  priceMem: 0.0577,
  priceStep: 0.0000721,
  maxTxExMem: 14_000_000n,
  maxTxExSteps: 10_000_000_000n,
  coinsPerUtxoByte: 4310n,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  minFeeRefScriptCostPerByte: 15,
  costModels: { PlutusV1: {}, PlutusV2: {}, PlutusV3: {} },
};

function testKey(n: number) {
  const priv = hexToBytes(n.toString(16).padStart(2, '0').repeat(32));
  const pub = ed25519.getPublicKey(priv);
  return { priv, pub, hash: bytesToHex(blake2b224(pub)) };
}
const ALICE = testKey(1);
const BOB = testKey(2);
const CAROL = testKey(3);
const DAVE = testKey(4);
const PAY = testKey(9);

const keyAddress = Address.fromBytes(Uint8Array.from([0x60, ...hexToBytes(PAY.hash)]));
const scriptAddress = Address.fromBytes(Uint8Array.from([0x70, ...hexToBytes('ee'.repeat(28))]));

const utxo = (address: Address.Address, txByte: string, lovelace: bigint) =>
  new UTxO.UTxO({ transactionId: TransactionHash.fromHex(txByte.repeat(32)), index: 0n, address, assets: Assets.fromLovelace(lovelace) });
const KEY_UTXO = utxo(keyAddress, 'f1', 50_000_000n);
// Larger than the key UTxO, so a largest first pick would take it if it were not filtered out.
const SCRIPT_UTXO = utxo(scriptAddress, 'f2', 900_000_000n);

const unused = async (): Promise<never> => {
  throw new Error('offline test asked the wallet');
};
const wallet = {
  getUsedAddresses: async () => [Address.toHex(keyAddress)],
  getUnusedAddresses: async () => [],
  getRewardAddresses: async () => [],
  getChangeAddress: async () => Address.toHex(keyAddress),
  getNetworkId: async () => 0,
  getUtxos: unused,
  getBalance: unused,
  getCollateral: unused,
  getExtensions: async () => [],
  signTx: unused,
  signData: unused,
  submitTx: unused,
} as unknown as WalletApi;

const offlineTx = (): DrepTxBuilder =>
  Client.make(preprod).withKoios({ baseUrl: 'http://offline.invalid' }).withCip30(wallet as never).newTx() as unknown as DrepTxBuilder;

const control = majorityScript([ALICE.hash, BOB.hash], 2);
const PAYLOAD = encodePayload({
  events: [
    {
      tag: 'create',
      mode: 'open',
      control: control.hash,
      admission: null,
      profile: { url: `https://preprod.dreptalk.com/group-profile/${'ab'.repeat(32)}.jsonld`, dataHash: 'cd'.repeat(32) },
    },
    { tag: 'join', group: { local: 0 }, member: { kind: 'key', hash: ALICE.hash } },
    { tag: 'join', group: { local: 0 }, member: { kind: 'key', hash: BOB.hash } },
  ],
  scripts: [control.script],
});
const TIP = 90_000_000;

const build = (over: { optionalKeys?: string[]; invalidBeforeSlot?: number; utxos?: UTxO.UTxO[]; excludeInputs?: Array<{ txHash: string; index: number }> } = {}) =>
  buildGroupTxFrom(offlineTx(), {
    utxos: over.utxos ?? [KEY_UTXO],
    params: PARAMS,
    changeAddress: keyAddress,
    payload: PAYLOAD,
    requiredSigners: [ALICE.hash, BOB.hash],
    optionalKeys: over.optionalKeys ?? [],
    tipSlot: TIP,
    invalidBeforeSlot: over.invalidBeforeSlot,
    slotConfig: preprod.slotConfig,
    excludeInputs: over.excludeInputs,
  });

const feeOf = (hex: string): bigint => Transaction.fromCBORHex(hex).body.fee;

function witness(bodyHash: string, k: ReturnType<typeof testKey>, role: 'signer' | 'funding'): PendingWitness {
  const ws = TransactionWitnessSet.fromVKeyWitnesses([
    new TransactionWitnessSet.VKeyWitness({
      vkey: VKey.fromBytes(k.pub),
      signature: Ed25519Signature.fromBytes(ed25519.sign(hexToBytes(bodyHash), k.priv)),
    }),
  ]);
  return { key_hash: k.hash, witness_hex: TransactionWitnessSet.toCBORHex(ws), role };
}

describe('feeHeadroomKeys', () => {
  it('counts the optional keys that are not required signers, once each', () => {
    expect(feeHeadroomKeys([ALICE.hash], [ALICE.hash, CAROL.hash, CAROL.hash.toUpperCase(), DAVE.hash])).toBe(2);
    expect(feeHeadroomKeys([ALICE.hash, BOB.hash], [])).toBe(0);
  });
});

describe('withWitnessHeadroom', () => {
  it('raises the fee constant by one witness size per key', () => {
    expect(withWitnessHeadroom(PARAMS, 3).minFeeB).toBe(PARAMS.minFeeB + 3 * WITNESS_FEE_BYTES * PARAMS.minFeeA);
    expect(withWitnessHeadroom(PARAMS, 0)).toEqual(PARAMS);
  });
});

describe('keyPaymentUtxos', () => {
  it('keeps only UTxOs at a key payment address', () => {
    expect(keyPaymentUtxos([SCRIPT_UTXO, KEY_UTXO])).toEqual([KEY_UTXO]);
  });
});

describe('withoutInputs', () => {
  it('drops the named outputs by hash and index, any case', () => {
    const second = new UTxO.UTxO({ transactionId: TransactionHash.fromHex('f1'.repeat(32)), index: 1n, address: keyAddress, assets: Assets.fromLovelace(1n) });
    expect(withoutInputs([KEY_UTXO, second], [{ txHash: 'F1'.repeat(32), index: 0 }])).toEqual([second]);
    expect(withoutInputs([KEY_UTXO], [])).toEqual([KEY_UTXO]);
  });
});

describe('queueGroupOps', () => {
  it('queues the payload, each signer, the validity end and the attribution tag', () => {
    const calls: Array<[string, unknown]> = [];
    const stub = new Proxy(
      {},
      {
        get: (_t, name: string) => (arg: unknown) => {
          calls.push([name, arg]);
          return stub;
        },
      },
    ) as DrepTxBuilder;
    queueGroupOps(stub, { payload: PAYLOAD, requiredSigners: [ALICE.hash, BOB.hash], invalidHereafterSlot: 1000n });
    expect(calls.map(([n]) => n)).toEqual(['attachMetadata', 'addSigner', 'addSigner', 'setValidity', 'attachMetadata']);
    expect((calls[0][1] as { label: bigint }).label).toBe(8416n);
    expect((calls[4][1] as { label: bigint }).label).toBe(674n);
  });
});

describe('buildGroupTxFrom', () => {
  it('builds the exact shape the server splices witnesses into', async () => {
    const { unsignedTxHex, bodyHashHex } = await build();
    const bytes = hexToBytes(unsignedTxHex);
    expect(bytes[0]).toBe(0x84);
    const decoded = decodeGroupTx(unsignedTxHex);
    expect(unsignedShapeError(decoded)).toBeNull();
    expect(bytes[1 + Transaction.extractBodyBytes(bytes).length]).toBe(0xa0);
    expect(bodyHashHex).toBe(decoded.bodyHash);
  });

  it('carries the exact payload bytes under the group label, bound by the aux hash', async () => {
    const decoded = decodeGroupTx((await build()).unsignedTxHex);
    expect(bytesToHex(decoded.chain.payload as Uint8Array)).toBe(bytesToHex(PAYLOAD));
    expect(decoded.facts.auxHashMatches).toBe(true);
    expect(decoded.facts.groupPayloads).toBe(1);
    expect(decoded.decoded?.events.every((e) => e.ok)).toBe(true);
  });

  it('keeps the exact bytes of approvals followed by a control update', async () => {
    const group = { txHash: '10'.repeat(32), index: 0 };
    const rotated = majorityScript([ALICE.hash, CAROL.hash, DAVE.hash], 2);
    const payload = encodePayload({
      events: [
        { tag: 'approve', join: { txHash: '30'.repeat(32), index: 1 } },
        { tag: 'update', group, seq: 7n, changes: { control: rotated.hash, profile: { url: `https://example.org/${'p'.repeat(90)}`, dataHash: 'ef'.repeat(32) } } },
      ],
      scripts: [rotated.script],
    });
    const { unsignedTxHex } = await buildGroupTxFrom(offlineTx(), {
      utxos: [KEY_UTXO],
      params: PARAMS,
      changeAddress: keyAddress,
      payload,
      requiredSigners: [ALICE.hash, CAROL.hash, DAVE.hash],
      optionalKeys: [BOB.hash],
      tipSlot: TIP,
      slotConfig: preprod.slotConfig,
    });
    expect(bytesToHex(decodeGroupTx(unsignedTxHex).chain.payload as Uint8Array)).toBe(bytesToHex(payload));
  });

  it('declares the required signers and ends validity 48 hours after the tip', async () => {
    const decoded = decodeGroupTx((await build()).unsignedTxHex);
    expect(decoded.chain.requiredSigners).toEqual([ALICE.hash, BOB.hash]);
    expect(decoded.chain.invalidHereafter).toBe(BigInt(TIP + ACTION_TTL_SECONDS));
    expect(decoded.chain.invalidBefore).toBeNull();
  });

  it('sets the validity start for a member script with an after lock', async () => {
    const decoded = decodeGroupTx((await build({ invalidBeforeSlot: TIP - 10 })).unsignedTxHex);
    expect(decoded.chain.invalidBefore).toBe(BigInt(TIP - 10));
  });

  it('spends only key payment address inputs', async () => {
    const decoded = decodeGroupTx((await build({ utxos: [SCRIPT_UTXO, KEY_UTXO] })).unsignedTxHex);
    expect(decoded.inputs).toEqual([{ txHash: 'f1'.repeat(32), index: 0 }]);
  });

  it('refuses a wallet without funds at a key payment address', async () => {
    await expect(build({ utxos: [SCRIPT_UTXO] })).rejects.toThrow(/key payment address/);
  });

  it('leaves out the outputs an open action already spends', async () => {
    const other = utxo(keyAddress, 'f3', 20_000_000n);
    const decoded = decodeGroupTx((await build({ utxos: [KEY_UTXO, other], excludeInputs: [{ txHash: 'F1'.repeat(32), index: 0 }] })).unsignedTxHex);
    expect(decoded.inputs).toEqual([{ txHash: 'f3'.repeat(32), index: 0 }]);
  });

  it('says the funds are held when every key payment output is spent by an open action', async () => {
    await expect(build({ excludeInputs: [{ txHash: 'f1'.repeat(32), index: 0 }] })).rejects.toThrow(FUNDS_HELD);
  });

  it('pays a fee that covers every witness the server folds in, optional keys included', async () => {
    const { unsignedTxHex, bodyHashHex } = await build({ optionalKeys: [CAROL.hash, DAVE.hash] });
    const fee = feeOf(unsignedTxHex);
    const signed = assembleTx(unsignedTxHex, [
      witness(bodyHashHex, ALICE, 'signer'),
      witness(bodyHashHex, BOB, 'signer'),
      witness(bodyHashHex, CAROL, 'signer'),
      witness(bodyHashHex, DAVE, 'signer'),
      witness(bodyHashHex, PAY, 'funding'),
    ]);
    const minFee = BigInt(PARAMS.minFeeA) * BigInt(signed.length / 2) + BigInt(PARAMS.minFeeB);
    expect(minFee).toBeLessThanOrEqual(fee);

    // The control without headroom: the same witnesses would not be covered.
    const bare = await build();
    const bareFee = feeOf(bare.unsignedTxHex);
    expect(fee - bareFee).toBe(BigInt(2 * WITNESS_FEE_BYTES * PARAMS.minFeeA));
    const bareSigned = assembleTx(bare.unsignedTxHex, [
      witness(bare.bodyHashHex, ALICE, 'signer'),
      witness(bare.bodyHashHex, BOB, 'signer'),
      witness(bare.bodyHashHex, CAROL, 'signer'),
      witness(bare.bodyHashHex, DAVE, 'signer'),
      witness(bare.bodyHashHex, PAY, 'funding'),
    ]);
    expect(BigInt(PARAMS.minFeeA) * BigInt(bareSigned.length / 2) + BigInt(PARAMS.minFeeB)).toBeGreaterThan(bareFee);
  });
});

describe('buildSendToSelfFrom', () => {
  const SECOND = utxo(keyAddress, 'f3', 20_000_000n);
  const TINY = utxo(keyAddress, 'f4', 500_000n);
  const send = (inputs: Array<{ txHash: string; index: number }>) =>
    buildSendToSelfFrom(offlineTx(), { utxos: [KEY_UTXO, SECOND, TINY, SCRIPT_UTXO], inputs, params: PARAMS, changeAddress: keyAddress });

  it('spends exactly the given fee inputs, all value back to the wallet', async () => {
    const tx = await (await send([{ txHash: 'F3'.repeat(32), index: 0 }])).toTransaction();
    expect(tx.body.inputs.map((i) => `${TransactionHash.toHex(i.transactionId)}#${i.index}`)).toEqual([`${'f3'.repeat(32)}#0`]);
    expect(tx.body.outputs).toHaveLength(1);
    expect(Address.toHex(tx.body.outputs[0].address)).toBe(Address.toHex(keyAddress));
    expect(BigInt(tx.body.outputs[0].assets.lovelace) + tx.body.fee).toBe(20_000_000n);
  });

  it('fails on a fee input set too small for the fee instead of adding wallet inputs', async () => {
    await expect(send([{ txHash: 'f4'.repeat(32), index: 0 }])).rejects.toThrow(/Insufficient funds/);
  });

  it('fails when a fee input is no longer in the wallet', async () => {
    await expect(send([{ txHash: 'f9'.repeat(32), index: 0 }])).rejects.toThrow(/no longer in the wallet/);
  });
});
