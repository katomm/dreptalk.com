// Unit tests for buildGovernanceAction: the single construction helper that
// turns a GovActionSpec into the SDK's typed GovernanceAction union. Pure
// (no network, no wallet), so every arm runs offline. Also covers the reward
// account and anchor construction govActionTx.ts builds inline for every
// proposal, assertions that used to sit on a retired InfoAction-only builder
// and now sit directly on the SDK calls.

import { describe, it, expect } from 'vitest';
import { Anchor, GovernanceAction, RewardAccount, ScriptHash, Url } from '@evolution-sdk/evolution';
import { buildGovernanceAction } from './govActionParts.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';
import { GUARDRAIL_SCRIPT_HASH_HEX } from './guardrailScript.js';

// Deterministic test fixtures.
const REWARD_ADDRESS_HEX = `e0${'00'.repeat(28)}`; // testnet-style reward address (29 bytes)
const ANCHOR_URL = 'ipfs://bafyfake';
// 64 hex chars = 32 bytes, a valid blake2b-256 placeholder.
const ANCHOR_HASH_HEX = 'ab'.repeat(32);
const TX_HASH_HEX = 'cd'.repeat(32);
const KEY_HASH_HEX = '11'.repeat(28);
const SCRIPT_HASH_HEX = '22'.repeat(28);

describe('InfoAction proposal parts (the reward account and anchor govActionTx.ts builds inline, InfoAction itself is covered below)', () => {
  it('round-trips the anchor URL and hash via toJSON', () => {
    const anchor = new Anchor.Anchor({
      anchorUrl: new Url.Url({ href: ANCHOR_URL }),
      anchorDataHash: hexToBytes(ANCHOR_HASH_HEX),
    });

    const json = anchor.toJSON();
    expect(json.anchorUrl).toBe(ANCHOR_URL);
    expect(json.anchorDataHash).toBe(ANCHOR_HASH_HEX);
  });

  it('builds a RewardAccount matching the given hex', () => {
    const rewardAccount = RewardAccount.fromHex(REWARD_ADDRESS_HEX);
    expect(rewardAccount).toEqual(RewardAccount.fromHex(REWARD_ADDRESS_HEX));
  });
});

describe('buildGovernanceAction', () => {
  it('builds an InfoAction with no fields', () => {
    const action = buildGovernanceAction({ type: 'InfoAction' });
    expect(action.toJSON()).toEqual({ _tag: 'InfoAction' });
  });

  it('builds a NoConfidence action with a null prev id', () => {
    const action = buildGovernanceAction({ type: 'NoConfidence', prev: null });
    const json = action.toJSON() as { _tag: string; govActionId: unknown };
    expect(json._tag).toBe('NoConfidenceAction');
    expect(json.govActionId).toBeNull();
  });

  it('builds a NoConfidence action with a set prev id', () => {
    const action = buildGovernanceAction({
      type: 'NoConfidence',
      prev: { txHashHex: TX_HASH_HEX, index: 2 },
    });
    const json = action.toJSON() as {
      _tag: string;
      govActionId: { transactionId: unknown; govActionIndex: bigint } | null;
    };
    expect(json._tag).toBe('NoConfidenceAction');
    expect(json.govActionId).not.toBeNull();
    expect(json.govActionId?.govActionIndex).toBe(2n);
  });

  it('builds a HardForkInitiation action with the protocol version', () => {
    const action = buildGovernanceAction({
      type: 'HardForkInitiation',
      prev: null,
      version: { major: 10, minor: 1 },
    });
    const json = action.toJSON() as {
      _tag: string;
      govActionId: unknown;
      protocolVersion: { major: bigint; minor: bigint };
    };
    expect(json._tag).toBe('HardForkInitiationAction');
    expect(json.govActionId).toBeNull();
    expect(json.protocolVersion.major).toBe(10n);
    expect(json.protocolVersion.minor).toBe(1n);
  });

  it('builds a NewConstitution action with an anchor and no script hash', () => {
    const action = buildGovernanceAction({
      type: 'NewConstitution',
      prev: null,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
      scriptHashHex: null,
    });
    const json = action.toJSON() as {
      _tag: string;
      constitution: { toJSON(): { anchor: { anchorUrl: string; anchorDataHash: string }; scriptHash: { hash: string } | null } };
    };
    expect(json._tag).toBe('NewConstitutionAction');
    const constitutionJson = json.constitution.toJSON();
    expect(constitutionJson.anchor.anchorUrl).toBe(ANCHOR_URL);
    expect(constitutionJson.anchor.anchorDataHash).toBe(ANCHOR_HASH_HEX);
    expect(constitutionJson.scriptHash).toBeNull();
  });

  it('builds a NewConstitution action with a guardrail script hash', () => {
    const action = buildGovernanceAction({
      type: 'NewConstitution',
      prev: { txHashHex: TX_HASH_HEX, index: 0 },
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
      scriptHashHex: SCRIPT_HASH_HEX,
    });
    const json = action.toJSON() as {
      constitution: { toJSON(): { scriptHash: { hash: string } | null } };
    };
    expect(json.constitution.toJSON().scriptHash?.hash).toBe(SCRIPT_HASH_HEX);
  });

  it('builds an UpdateCommittee action with removed and added members plus threshold', () => {
    const action = buildGovernanceAction({
      type: 'UpdateCommittee',
      prev: null,
      remove: [{ hashHex: KEY_HASH_HEX, isScript: false }],
      add: [
        { credential: { hashHex: SCRIPT_HASH_HEX, isScript: true }, expiryEpoch: 500 },
      ],
      quorum: { numerator: 2, denominator: 3 },
    });
    const json = action.toJSON() as {
      _tag: string;
      membersToRemove: readonly { hash: Uint8Array }[];
      membersToAdd: Map<{ hash: Uint8Array }, bigint>;
      threshold: { numerator: bigint; denominator: bigint };
    };
    expect(json._tag).toBe('UpdateCommitteeAction');
    expect(json.membersToRemove).toHaveLength(1);
    expect(bytesToHex(json.membersToRemove[0].hash)).toBe(KEY_HASH_HEX);
    const addedEntries = Array.from(json.membersToAdd.entries());
    expect(addedEntries).toHaveLength(1);
    expect(bytesToHex(addedEntries[0][0].hash)).toBe(SCRIPT_HASH_HEX);
    expect(addedEntries[0][1]).toBe(500n);
    expect(json.threshold.numerator).toBe(2n);
    expect(json.threshold.denominator).toBe(3n);
  });

  it('round-trips one built action of each type through GovernanceAction CBOR', () => {
    const specs: Parameters<typeof buildGovernanceAction>[0][] = [
      { type: 'InfoAction' },
      { type: 'NoConfidence', prev: { txHashHex: TX_HASH_HEX, index: 1 } },
      { type: 'HardForkInitiation', prev: null, version: { major: 10, minor: 0 } },
      {
        type: 'NewConstitution',
        prev: null,
        anchorUrl: ANCHOR_URL,
        anchorHashHex: ANCHOR_HASH_HEX,
        scriptHashHex: SCRIPT_HASH_HEX,
      },
      {
        type: 'UpdateCommittee',
        prev: null,
        remove: [{ hashHex: KEY_HASH_HEX, isScript: false }],
        add: [{ credential: { hashHex: SCRIPT_HASH_HEX, isScript: true }, expiryEpoch: 500 }],
        quorum: { numerator: 2, denominator: 3 },
      },
    ];

    for (const spec of specs) {
      const action = buildGovernanceAction(spec);
      const hex = GovernanceAction.toCBORHex(action);
      expect(hex).toMatch(/^[0-9a-f]+$/);
      const decoded = GovernanceAction.fromCBORHex(hex);
      expect(decoded._tag).toBe(action._tag);
    }
  });
});

describe('buildGovernanceAction TreasuryWithdrawals', () => {
  const KEY_RECIPIENT = `e0${'ab'.repeat(28)}`;
  const SCRIPT_RECIPIENT = `f0${'cd'.repeat(28)}`;
  const KNOWN = { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX } as const;

  function treasury(action: GovernanceAction.GovernanceAction): GovernanceAction.TreasuryWithdrawalsAction {
    if (action._tag !== 'TreasuryWithdrawalsAction') throw new Error(`expected a treasury action, got ${action._tag}`);
    return action;
  }

  it('builds one map entry per recipient with the guardrail as policy hash', () => {
    const action = treasury(
      buildGovernanceAction({
        type: 'TreasuryWithdrawals',
        withdrawals: [
          { rewardAddressHex: KEY_RECIPIENT, lovelace: 1_000_000n },
          { rewardAddressHex: SCRIPT_RECIPIENT, lovelace: 2_500_000n },
        ],
        guardrail: KNOWN,
      }),
    );
    expect([...action.withdrawals].map(([account, lovelace]) => [RewardAccount.toHex(account), lovelace])).toEqual([
      [KEY_RECIPIENT, 1_000_000n],
      [SCRIPT_RECIPIENT, 2_500_000n],
    ]);
    expect(action.policyHash ? ScriptHash.toHex(action.policyHash) : null).toBe(GUARDRAIL_SCRIPT_HASH_HEX);
  });

  it('carries no policy hash when the chain proves there is no guardrail', () => {
    const action = treasury(
      buildGovernanceAction({
        type: 'TreasuryWithdrawals',
        withdrawals: [{ rewardAddressHex: KEY_RECIPIENT, lovelace: 1n }],
        guardrail: { state: 'absent' },
      }),
    );
    expect(action.policyHash).toBeNull();
  });

  it('refuses a recipient listed twice, also when the hex differs only in case', () => {
    expect(() =>
      buildGovernanceAction({
        type: 'TreasuryWithdrawals',
        withdrawals: [
          { rewardAddressHex: KEY_RECIPIENT, lovelace: 1n },
          { rewardAddressHex: KEY_RECIPIENT.toUpperCase(), lovelace: 2n },
        ],
        guardrail: KNOWN,
      }),
    ).toThrow(/^Duplicate treasury withdrawal recipient/);
  });

  it('round-trips through CBOR with every recipient', () => {
    const action = buildGovernanceAction({
      type: 'TreasuryWithdrawals',
      withdrawals: [
        { rewardAddressHex: KEY_RECIPIENT, lovelace: 1_000_000n },
        { rewardAddressHex: SCRIPT_RECIPIENT, lovelace: 2_500_000n },
      ],
      guardrail: KNOWN,
    });
    const decoded = treasury(GovernanceAction.fromCBORHex(GovernanceAction.toCBORHex(action)));
    expect(decoded.withdrawals.size).toBe(2);
    expect(decoded.policyHash ? ScriptHash.toHex(decoded.policyHash) : null).toBe(GUARDRAIL_SCRIPT_HASH_HEX);
  });
});

describe('ParameterChange', () => {
  const GUARDRAIL = 'fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64';
  it('builds the action with the previous id, the update and the guardrail', () => {
    const action = buildGovernanceAction({
      type: 'ParameterChange',
      prev: { txHashHex: 'ab'.repeat(32), index: 1 },
      values: { k: { n: 600n, d: 1n } },
      guardrail: { state: 'known', scriptHash: GUARDRAIL },
    });
    if (action._tag !== 'ParameterChangeAction') throw new Error(action._tag);
    expect(action.protocolParamUpdate.nOpt).toBe(600n);
    expect(action.policyHash ? ScriptHash.toHex(action.policyHash) : null).toBe(GUARDRAIL);
    expect(action.govActionId).not.toBeNull();
  });
  it('leaves the policy hash empty for a proven absence', () => {
    const action = buildGovernanceAction({
      type: 'ParameterChange',
      prev: null,
      values: { tau: { n: 1n, d: 4n } },
      guardrail: { state: 'absent' },
    });
    if (action._tag !== 'ParameterChangeAction') throw new Error(action._tag);
    expect(action.policyHash).toBeNull();
    expect(action.govActionId).toBeNull();
  });
});
