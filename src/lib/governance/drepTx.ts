// Client-side builder for the Conway reg_drep transaction.
// Non-custodial: the server never sees a private key; the wallet extension signs and submits.
// Uses EvolutionSDK with our /api/koios proxy to avoid CORS on Koios endpoints.

import { Anchor, Client, Credential, Transaction, Url, mainnet, preprod } from '@evolution-sdk/evolution';
import { dreptalkCip20Metadatum, DREPTALK_CIP20_LABEL } from '../cardano/tx.js';
import { hexToBytes } from '../crypto/hex.js';

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

export interface RegisterDRepOpts {
  /** CIP-30 wallet API obtained from cardano[walletId].enable(). */
  walletApi: WalletApi;
  network: 'preprod' | 'mainnet';
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

  const client = Client.make(opts.network === 'mainnet' ? mainnet : preprod)
    .withKoios({ baseUrl: `${opts.origin}/api/koios` })
    .withCip30(opts.walletApi);

  const built = await client
    .newTx()
    .registerDRep({ drepCredential, anchor })
    .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() })
    .build();

  const unsignedTxHex = Transaction.toCBORHex(await built.toTransaction());
  const witnessSetHex = await opts.walletApi.signTx(unsignedTxHex, false);
  const signedTxHex = Transaction.addVKeyWitnessesHex(unsignedTxHex, witnessSetHex);
  const txHash = await opts.walletApi.submitTx(signedTxHex);

  return { txHash };
}
