// LIVE preprod e2e (gated). Skipped unless DREPTALK_LIVE=1, because it needs
// outbound network to preprod Koios and the preprod test wallet (mnemonic at
// ~/Sites/dreptalk-planning/test-wallet/wallet.json, outside this repo). It is
// NOT a CI test; the deterministic guards live in drepTx.test.ts and the auth
// handler tests. Run it with: DREPTALK_LIVE=1 npx vitest run src/lib/governance/drepTx.live.test.ts
//
// It proves the two real-world things offline tests cannot:
//   1. A real DRep login: a CIP-8 COSE signed with the actual DRep key verifies
//      and resolves to a registered, active DRep via live Koios.
//   2. The reg_drep fee covers the DRep-key witness: building against live
//      preprod protocol params, the fee WITH addSigner exceeds the fee WITHOUT
//      it by ~one vkey witness (the "Insufficient fee" bug this guards).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { encode } from 'cborg';
import * as E from '@evolution-sdk/evolution';
import { Address, Anchor, Client, Credential, DRep, KeyHash, Transaction, Url, VotingProcedures, preprod } from '@evolution-sdk/evolution';
import { blake2b224 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { drepCredentialAddress, drepIdFromPubKey } from '../cardano/identity.js';
import { verifyCip8 } from '../auth/cose.js';
import { createKoiosClient } from '../koios/client.js';
import { resolveDRep } from '../auth/resolveRole.js';
import { buildGovActionId, queueRegisterDrepOps, queueVotesOps } from './drepTx.js';
import { DREPTALK_CIP20_LABEL, dreptalkCip20Metadatum } from '../cardano/tx.js';

const LIVE = process.env.DREPTALK_LIVE === '1';
const KOIOS = 'https://preprod.koios.rest/api/v1';
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

// Builds a CIP-8 COSE_Sign1 + COSE_Key signed with the real DRep key over a
// type-6 (enterprise) address, exactly as a CIP-95 wallet's signData would.
function buildDrepCose(opts: { pubKey: Uint8Array; addressBytes: Uint8Array; payload: string; sign: (m: Uint8Array) => Uint8Array }) {
  const protectedMap = new Map<number | string, unknown>([[1, -8], ['address', opts.addressBytes]]);
  const protectedBstr = encode(protectedMap);
  const payloadBytes = new TextEncoder().encode(opts.payload);
  const toBeSigned = encode(['Signature1', protectedBstr, new Uint8Array(0), payloadBytes]);
  const sig = opts.sign(toBeSigned);
  const coseSign1 = [protectedBstr, new Map([['hashed', false]]), payloadBytes, sig];
  const coseKey = new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, opts.pubKey]]);
  return { signatureHex: bytesToHex(encode(coseSign1)), keyHex: bytesToHex(encode(coseKey)) };
}

describe.skipIf(!LIVE)('LIVE preprod e2e', () => {
  it('DRep login: a real DRep-key COSE verifies and resolves to an active DRep via Koios', async () => {
    const { pubKey, keyHash, sign } = loadDrepKey();
    const payload = 'dreptalk:preprod-live:nonce:1700000000';
    const addressBytes = new Uint8Array(29);
    addressBytes[0] = 0x60; // preprod type-6 enterprise header
    addressBytes.set(keyHash, 1);
    expect(bytesToHex(addressBytes)).toBe(drepCredentialAddress(keyHash, 'preprod'));

    const { signatureHex, keyHex } = buildDrepCose({ pubKey, addressBytes, payload, sign });

    const verified = await verifyCip8({ signatureHex, keyHex, expectedPayload: payload });
    expect(verified.ok).toBe(true);
    expect(verified.addressBytes![0]).toBe(0x60);

    const drepId = drepIdFromPubKey(verified.pubKey!);
    const koios = createKoiosClient({ baseUrl: KOIOS });
    const resolution = await resolveDRep(koios, drepId);
    expect(resolution.isDrep).toBe(true); // the test wallet's DRep is registered + active on preprod
  }, 30_000);

  it('reg_drep fee covers the DRep-key witness against live preprod params', async () => {
    const { paymentAddress, keyHash } = loadDrepKey();
    const drepCredential = Credential.makeKeyHash(keyHash);
    const anchor = new Anchor.Anchor({
      anchorUrl: new Url.Url({ href: `https://preprod.dreptalk.com/drep/${'0'.repeat(64)}.json` }),
      anchorDataHash: new Uint8Array(32),
    });
    const client = Client.make(preprod).withKoios({ baseUrl: KOIOS }).withAddress(paymentAddress);

    // WITH the fix: the DRep key is declared as a required signer.
    const withSigner = await queueRegisterDrepOps(
      client.newTx() as unknown as Parameters<typeof queueRegisterDrepOps>[0],
      { drepCredential, anchor, drepKeyHash: keyHash },
    ).build();

    // Control WITHOUT addSigner: the buggy path.
    const withoutSigner = await client
      .newTx()
      .registerDRep({ drepCredential, anchor })
      .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() })
      .build();

    const feeWith = (await withSigner.toTransaction()).body.fee;
    const feeWithout = (await withoutSigner.toTransaction()).body.fee;
    const delta = feeWith - feeWithout;

    // One extra vkey witness is ~100 bytes; at minFeeA=44 that is ~4400 lovelace.
    expect(delta).toBeGreaterThan(2_000n);
    expect(delta).toBeLessThan(8_000n);
  }, 60_000);

  it('builds a real DRep vote tx against live preprod params, serializes, and the fee covers the DRep-key witness', async () => {
    const { paymentAddress, keyHash } = loadDrepKey();

    // Pick a currently-votable preprod governance action (none of the terminal epochs set).
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

    // Fund the deposit-free vote tx from the wallet's UTxOs, exactly as castDRepVote
    // does (collectFrom + availableUtxos); a vote-only tx has no output to drive
    // automatic coin selection, so the inputs are supplied explicitly.
    const reader = Client.make(preprod).withKoios({ baseUrl: KOIOS });
    const utxos = await reader.getUtxos(Address.fromBech32(paymentAddress));
    expect(utxos.length, 'test wallet has no UTxOs to cover the fee').toBeGreaterThan(0);

    const client = Client.make(preprod).withKoios({ baseUrl: KOIOS }).withAddress(paymentAddress);

    // WITH the fix: queueVotesOps declares the DRep key as a required signer.
    const withSigner = await queueVotesOps(
      client.newTx() as unknown as Parameters<typeof queueVotesOps>[0],
      { drepKeyHash: keyHash, votes: [{ govActionId: buildGovActionId(govActionId), vote: 'abstain', anchor: null }] },
    )
      .collectFrom({ inputs: utxos })
      .build({ availableUtxos: utxos });

    const tx = await withSigner.toTransaction();
    // The vote actually landed in the tx body (CDDL key 19, voting_procedures).
    expect(tx.body.votingProcedures).toBeTruthy();
    expect(tx.body.fee).toBeGreaterThan(0n);
    // Serializes to CBOR exactly as signAndSubmit does before the wallet signs.
    const cborHex = Transaction.toCBORHex(tx);
    expect(cborHex).toMatch(/^[0-9a-f]+$/);
    expect(cborHex.length).toBeGreaterThan(200);

    // Control WITHOUT addSigner: the buggy path that underpays the vote witness.
    const voter = new VotingProcedures.DRepVoter({ drep: DRep.fromKeyHash(KeyHash.fromBytes(keyHash)) });
    const procedure = new VotingProcedures.VotingProcedure({ vote: VotingProcedures.abstain(), anchor: null });
    const votingProcedures = VotingProcedures.singleVote(voter, buildGovActionId(govActionId), procedure);
    const withoutSigner = await client
      .newTx()
      .vote({ votingProcedures })
      .attachMetadata({ label: DREPTALK_CIP20_LABEL, metadata: dreptalkCip20Metadatum() })
      .collectFrom({ inputs: utxos })
      .build({ availableUtxos: utxos });

    const delta = tx.body.fee - (await withoutSigner.toTransaction()).body.fee;
    expect(delta).toBeGreaterThan(2_000n);
    expect(delta).toBeLessThan(8_000n);
  }, 60_000);
});
