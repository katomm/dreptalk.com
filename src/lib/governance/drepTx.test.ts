// Unit tests for the pure construction helpers in drepTx.ts.
// buildRegisterDrepParts requires no network or wallet, so it runs offline.
// The full registerDRep function is covered by the preprod e2e suite (Phase B-11).

import type { GovernanceAction, VotingProcedures } from '@evolution-sdk/evolution';
import { Anchor, Url } from '@evolution-sdk/evolution';
import { METADATA_LABEL } from 'cip-179';
import { describe, expect, it } from 'vitest';
import { DREPTALK_CIP20_LABEL } from '../cardano/tx.js';
import { bytesToHex } from '../crypto/hex.js';
import {
  buildDrepTarget,
  buildGovActionId,
  buildRegisterDrepParts,
  castDRepVotes,
  queueDelegateVotesOps,
  queueDeregisterDrepOps,
  queueRegisterDrepOps,
  queueSurveyResponseOps,
  queueUpdateDrepOps,
  queueVotesOps,
  stakeCredentialFromRewardAddress,
} from './drepTx.js';

// Deterministic test fixtures.
const DREP_KEY_HASH = new Uint8Array(28).fill(0xab); // 28-byte blake2b-224 placeholder
const ANCHOR_URL =
  'https://dreptalk.com/drep/0000000000000000000000000000000000000000000000000000000000000000.json';
// 64 hex chars = 32 bytes, a valid blake2b-256 placeholder.
const ANCHOR_HASH_HEX = 'ab'.repeat(32);

// Records the ops queued onto a tx builder so we can assert the chain without a
// live wallet/provider. Each op returns the recorder so the chain is fluent.
function makeBuilderRecorder() {
  const calls: Array<{ op: string; arg: unknown }> = [];
  const rec = {
    registerDRep(arg: unknown) {
      calls.push({ op: 'registerDRep', arg });
      return rec;
    },
    updateDRep(arg: unknown) {
      calls.push({ op: 'updateDRep', arg });
      return rec;
    },
    deregisterDRep(arg: unknown) {
      calls.push({ op: 'deregisterDRep', arg });
      return rec;
    },
    delegateToDRep(arg: unknown) {
      calls.push({ op: 'delegateToDRep', arg });
      return rec;
    },
    addSigner(arg: unknown) {
      calls.push({ op: 'addSigner', arg });
      return rec;
    },
    attachMetadata(arg: unknown) {
      calls.push({ op: 'attachMetadata', arg });
      return rec;
    },
  };
  return { rec, calls };
}

function addSignerKeyHashHex(calls: Array<{ op: string; arg: unknown }>): string | null {
  const c = calls.find(x => x.op === 'addSigner');
  if (!c) return null;
  const keyHash = (c.arg as { keyHash: { hash: Uint8Array } }).keyHash.hash;
  return bytesToHex(keyHash);
}

describe('buildRegisterDrepParts', () => {
  it('returns a Credential and Anchor without throwing', () => {
    const { drepCredential, anchor } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    expect(drepCredential).toBeDefined();
    expect(anchor).toBeDefined();
  });

  it('constructs a KeyHash credential with the correct tag', () => {
    const { drepCredential } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    // Evolution SDK KeyHash has _tag "KeyHash".
    expect((drepCredential as { _tag: string })._tag).toBe('KeyHash');
  });

  it('round-trips the anchor URL via toJSON', () => {
    const { anchor } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    // Anchor.toJSON returns { _tag, anchorUrl: string, anchorDataHash: hex }.
    const json = anchor.toJSON();
    expect(json.anchorUrl).toBe(ANCHOR_URL);
  });

  it('round-trips the anchor hash via toJSON', () => {
    const { anchor } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    const json = anchor.toJSON();
    expect(json.anchorDataHash).toBe(ANCHOR_HASH_HEX);
  });

  it('throws on a hash that is too short (not 32 bytes)', () => {
    // hexToBytes('aa') = 1 byte, Anchor construction should reject a non-32-byte hash.
    expect(() =>
      buildRegisterDrepParts({
        drepKeyHash: DREP_KEY_HASH,
        anchorUrl: ANCHOR_URL,
        anchorHashHex: 'aa',
      }),
    ).toThrow();
  });
});

// Regression guard for the "Insufficient fee" bug: the reg_drep / unreg_drep
// certificate is witnessed by the DRep key (which controls no input), and
// EvolutionSDK only sizes the fee for declared signers. So our build chain MUST
// declare the DRep key via addSigner, or the fee falls one vkey witness short.
// These assert exactly that on the shared chains production uses. The real fee
// arithmetic against live preprod params is covered by the gated live e2e.
describe('queueRegisterDrepOps (fee: DRep key required signer)', () => {
  it('declares the DRep key as a required signer and queues the reg_drep cert', () => {
    const { drepCredential, anchor } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });
    const { rec, calls } = makeBuilderRecorder();

    queueRegisterDrepOps(rec as Parameters<typeof queueRegisterDrepOps>[0], {
      drepCredential,
      anchor,
      drepKeyHash: DREP_KEY_HASH,
    });

    expect(calls.some(c => c.op === 'registerDRep')).toBe(true);
    expect(addSignerKeyHashHex(calls)).toBe(bytesToHex(DREP_KEY_HASH));
  });
});

describe('queueDeregisterDrepOps (fee: DRep key required signer)', () => {
  it('declares the DRep key as a required signer and queues the unreg_drep cert', () => {
    const { drepCredential } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });
    const { rec, calls } = makeBuilderRecorder();

    queueDeregisterDrepOps(rec as Parameters<typeof queueDeregisterDrepOps>[0], {
      drepCredential,
      drepKeyHash: DREP_KEY_HASH,
    });

    expect(calls.some(c => c.op === 'deregisterDRep')).toBe(true);
    expect(addSignerKeyHashHex(calls)).toBe(bytesToHex(DREP_KEY_HASH));
  });
});

describe('queueUpdateDrepOps (fee: DRep key required signer)', () => {
  it('declares the DRep key as a required signer and queues the update_drep cert', () => {
    const { drepCredential, anchor } = buildRegisterDrepParts({
      drepKeyHash: DREP_KEY_HASH,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });
    const { rec, calls } = makeBuilderRecorder();

    queueUpdateDrepOps(rec as Parameters<typeof queueUpdateDrepOps>[0], {
      drepCredential,
      anchor,
      drepKeyHash: DREP_KEY_HASH,
    });

    const update = calls.find(c => c.op === 'updateDRep');
    expect(update).toBeDefined();
    // The new anchor must ride on the cert; without it the update is a no-op.
    expect((update!.arg as { anchor?: unknown }).anchor).toBeDefined();
    expect(addSignerKeyHashHex(calls)).toBe(bytesToHex(DREP_KEY_HASH));
    expect(calls.some(c => c.op === 'attachMetadata')).toBe(true);
  });
});

// Vote-delegation fixtures: a 28-byte DRep credential and a 28-byte stake hash.
const DREP_CRED_HEX = 'cd'.repeat(28);
const STAKE_HASH_HEX = 'ef'.repeat(28);

describe('buildDrepTarget', () => {
  it('builds a key-hash DRep target from a credential hash', () => {
    const target = buildDrepTarget({ credentialHex: DREP_CRED_HEX, isScript: false });
    expect((target as { _tag: string })._tag).toBe('KeyHashDRep');
  });

  it('builds a script-hash DRep target when the DRep is script-controlled', () => {
    const target = buildDrepTarget({ credentialHex: DREP_CRED_HEX, isScript: true });
    expect((target as { _tag: string })._tag).toBe('ScriptHashDRep');
  });
});

describe('stakeCredentialFromRewardAddress', () => {
  it('parses a key stake credential (header high nibble 0b1110)', () => {
    const r = stakeCredentialFromRewardAddress(`e0${STAKE_HASH_HEX}`);
    expect(r.isScript).toBe(false);
    expect((r.stakeCredential as { _tag: string })._tag).toBe('KeyHash');
    expect(bytesToHex(r.stakeKeyHash)).toBe(STAKE_HASH_HEX);
  });

  it('parses a script stake credential (header high nibble 0b1111)', () => {
    const r = stakeCredentialFromRewardAddress(`f0${STAKE_HASH_HEX}`);
    expect(r.isScript).toBe(true);
    expect((r.stakeCredential as { _tag: string })._tag).toBe('ScriptHash');
  });

  it('throws on an address that is not 29 bytes', () => {
    expect(() => stakeCredentialFromRewardAddress(`e0${'ef'.repeat(10)}`)).toThrow();
  });
});

// Regression guard mirroring the reg_drep fee test: the vote_deleg certificate
// is witnessed by the stake key (which controls no input), so the build chain
// MUST declare it via addSigner or the fee falls one vkey witness short.
describe('queueDelegateVotesOps (fee: stake key required signer)', () => {
  it('queues the vote_deleg cert and declares the stake key as a required signer', () => {
    const { stakeCredential, stakeKeyHash } = stakeCredentialFromRewardAddress(
      `e0${STAKE_HASH_HEX}`,
    );
    const drep = buildDrepTarget({ credentialHex: DREP_CRED_HEX, isScript: false });
    const { rec, calls } = makeBuilderRecorder();

    queueDelegateVotesOps(rec as Parameters<typeof queueDelegateVotesOps>[0], {
      stakeCredential,
      drep,
      stakeKeyHash,
    });

    expect(calls.some(c => c.op === 'delegateToDRep')).toBe(true);
    expect(addSignerKeyHashHex(calls)).toBe(STAKE_HASH_HEX);
    // The CIP-20 attribution tag (label 674) rides along, like register/retire.
    expect(calls.some(c => c.op === 'attachMetadata')).toBe(true);
  });
});

describe('buildGovActionId', () => {
  const txHash = 'a'.repeat(64);

  it('parses "<txHash>#<index>" into a GovActionId with matching index', () => {
    const id = buildGovActionId(`${txHash}#3`);
    expect(id.govActionIndex).toBe(3n);
    // transactionId.hash is the 32 raw bytes of the tx hash
    expect(id.transactionId.hash.length).toBe(32);
  });

  it('rejects a malformed id', () => {
    expect(() => buildGovActionId('not-an-id')).toThrow();
    expect(() => buildGovActionId(`${txHash}#-1`)).toThrow();
  });
});

describe('queueVotesOps (single vote)', () => {
  it('queues a one-vote procedure, the DRep signer, and the CIP-20 tag', () => {
    const calls: Record<string, unknown[]> = {};
    // Recording stub: every builder method records its args and returns the stub.
    // biome-ignore lint/suspicious/noExplicitAny: recording stub for builder methods
    const stub: any = new Proxy(
      {},
      {
        get: (_t, prop: string) => (arg: unknown) => {
          if (!calls[prop]) calls[prop] = [];
          calls[prop].push(arg);
          return stub;
        },
      },
    );

    const drepKeyHash = new Uint8Array(28).fill(7);
    queueVotesOps(stub, {
      drepKeyHash,
      votes: [{ govActionId: buildGovActionId(`${'a'.repeat(64)}#0`), vote: 'yes', anchor: null }],
    });

    expect(calls.vote).toHaveLength(1);
    expect(calls.addSigner).toHaveLength(1);
    expect(calls.attachMetadata).toHaveLength(1);
    const voteArg = calls.vote[0] as { votingProcedures: VotingProcedures.VotingProcedures };
    expect(voteArg.votingProcedures.procedures.size).toBe(1);
  });
});

describe('queueVotesOps (multi-vote)', () => {
  function makeStub() {
    const calls: Record<string, unknown[]> = {};
    // biome-ignore lint/suspicious/noExplicitAny: recording stub for builder methods
    const stub: any = new Proxy(
      {},
      {
        get: (_t, prop: string) => (arg: unknown) => {
          if (!calls[prop]) calls[prop] = [];
          calls[prop].push(arg);
          return stub;
        },
      },
    );
    return { stub, calls };
  }

  const drepKeyHash = new Uint8Array(28).fill(7);
  const idA = buildGovActionId(`${'a'.repeat(64)}#0`);
  const idB = buildGovActionId(`${'b'.repeat(64)}#1`);
  const idC = buildGovActionId(`${'c'.repeat(64)}#2`);
  const anchorA = new Anchor.Anchor({
    anchorUrl: new Url.Url({ href: 'https://dreptalk.com/vote-rationale/aa.json' }),
    anchorDataHash: new Uint8Array(32).fill(1),
  });
  const anchorC = new Anchor.Anchor({
    anchorUrl: new Url.Url({ href: 'https://dreptalk.com/vote-rationale/cc.json' }),
    anchorDataHash: new Uint8Array(32).fill(2),
  });

  it('builds ONE vote op with one voter entry holding all gov actions', () => {
    const { stub, calls } = makeStub();
    queueVotesOps(stub, {
      drepKeyHash,
      votes: [
        { govActionId: idA, vote: 'yes', anchor: anchorA },
        { govActionId: idB, vote: 'no', anchor: null },
        { govActionId: idC, vote: 'abstain', anchor: anchorC },
      ],
    });

    // Exactly one .vote() call: repeated calls would merge by object identity
    // and can emit duplicate CBOR map keys (SDK gotcha).
    expect(calls.vote).toHaveLength(1);
    expect(calls.addSigner).toHaveLength(1);
    expect(calls.attachMetadata).toHaveLength(1);

    const voteArg = calls.vote[0] as { votingProcedures: VotingProcedures.VotingProcedures };
    // One voter (the DRep), three gov actions under it.
    expect(voteArg.votingProcedures.procedures.size).toBe(1);
    const inner = [...voteArg.votingProcedures.procedures.values()][0] as Map<
      GovernanceAction.GovActionId,
      VotingProcedures.VotingProcedure
    >;
    expect(inner.size).toBe(3);
    // Anchors land on the right actions (multiVote keys by our instances).
    expect(inner.get(idA)?.anchor).toBe(anchorA);
    expect(inner.get(idB)?.anchor).toBeNull();
    expect(inner.get(idC)?.anchor).toBe(anchorC);
  });

  it('rejects an empty vote list', () => {
    const { stub } = makeStub();
    expect(() => queueVotesOps(stub, { drepKeyHash, votes: [] })).toThrow();
  });
});

describe('castDRepVotes input validation', () => {
  it('rejects duplicate governance actions before any network access', async () => {
    const dup = { govActionId: `${'a'.repeat(64)}#0`, vote: 'yes' as const };
    await expect(
      castDRepVotes({
        // Validation throws before the wallet is touched, so a bare object is fine.
        // biome-ignore lint/suspicious/noExplicitAny: unused past validation
        walletApi: {} as any,
        network: 'preprod',
        drepKeyHash: new Uint8Array(28).fill(7),
        origin: 'https://dreptalk.com',
        votes: [dup, { ...dup, vote: 'no' as const }],
      }),
    ).rejects.toThrow(/duplicate/i);
  });

  it('rejects an empty batch', async () => {
    await expect(
      castDRepVotes({
        // biome-ignore lint/suspicious/noExplicitAny: unused past validation
        walletApi: {} as any,
        network: 'preprod',
        drepKeyHash: new Uint8Array(28).fill(7),
        origin: 'https://dreptalk.com',
        votes: [],
      }),
    ).rejects.toThrow();
  });
});

describe('queueSurveyResponseOps', () => {
  function makeStub() {
    const calls: Record<string, unknown[]> = {};
    // biome-ignore lint/suspicious/noExplicitAny: recording stub for builder methods
    const stub: any = new Proxy(
      {},
      {
        get: (_t, prop: string) => (arg: unknown) => {
          if (!calls[prop]) calls[prop] = [];
          calls[prop].push(arg);
          return stub;
        },
      },
    );
    return { stub, calls };
  }

  // A metadatum tree the widget could emit: toTxMetadatum is a type-level
  // cast, so the exact same structure must come out at label 17.
  const payload = new Map<bigint, unknown>([[0n, ['responses', 1n]]]) as never;

  it('attaches the payload at label 17, one signer per key hash, and the CIP-20 tag', () => {
    const { stub, calls } = makeStub();
    const keyA = new Uint8Array(28).fill(1);
    const keyB = new Uint8Array(28).fill(2);
    queueSurveyResponseOps(stub, { payload, signerKeyHashes: [keyA, keyB] });

    const meta = calls.attachMetadata as Array<{ label: bigint; metadata: unknown }>;
    expect(meta.map(m => m.label)).toEqual([BigInt(METADATA_LABEL), DREPTALK_CIP20_LABEL]);
    expect(meta[0].metadata).toBe(payload);
    // Mechanism A lives in required_signers: a missing entry silently
    // invalidates the response, so the signer count is the assertion.
    expect(calls.addSigner).toHaveLength(2);
  });

  it('rejects an empty credential list — an unproven response would carry no signature', () => {
    const { stub } = makeStub();
    expect(() => queueSurveyResponseOps(stub, { payload, signerKeyHashes: [] })).toThrow();
  });
});
