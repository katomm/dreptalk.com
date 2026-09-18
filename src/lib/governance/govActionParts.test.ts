// Unit tests for buildGovernanceAction: the single construction helper that
// turns a GovActionSpec into the SDK's typed GovernanceAction union. Pure
// (no network, no wallet), so every arm runs offline. Also covers
// buildInfoActionProposeParts, moved here from the retired InfoAction-only builder.

import { describe, it, expect } from 'vitest';
import { GovernanceAction, RewardAccount } from '@evolution-sdk/evolution';
import { buildGovernanceAction, buildInfoActionProposeParts } from './govActionParts.js';
import { bytesToHex } from '../crypto/hex.js';

// Deterministic test fixtures.
const REWARD_ADDRESS_HEX = `e0${'00'.repeat(28)}`; // testnet-style reward address (29 bytes)
const ANCHOR_URL = 'ipfs://bafyfake';
// 64 hex chars = 32 bytes, a valid blake2b-256 placeholder.
const ANCHOR_HASH_HEX = 'ab'.repeat(32);
const TX_HASH_HEX = 'cd'.repeat(32);
const KEY_HASH_HEX = '11'.repeat(28);
const SCRIPT_HASH_HEX = '22'.repeat(28);

describe('buildInfoActionProposeParts', () => {
  it('builds an InfoAction proposal with a reward account and anchor', () => {
    const parts = buildInfoActionProposeParts({
      rewardAddressHex: REWARD_ADDRESS_HEX,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    expect(parts.rewardAccount).toBeDefined();
    expect(parts.governanceAction).toBeDefined();
    expect(parts.anchor).toBeDefined();
  });

  it('tags the governance action as InfoAction', () => {
    const parts = buildInfoActionProposeParts({
      rewardAddressHex: REWARD_ADDRESS_HEX,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    expect((parts.governanceAction as { _tag: string })._tag).toBe('InfoAction');
  });

  it('round-trips the anchor URL and hash via toJSON', () => {
    const { anchor } = buildInfoActionProposeParts({
      rewardAddressHex: REWARD_ADDRESS_HEX,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

    const json = anchor.toJSON();
    expect(json.anchorUrl).toBe(ANCHOR_URL);
    expect(json.anchorDataHash).toBe(ANCHOR_HASH_HEX);
  });

  it('builds a RewardAccount matching the given hex', () => {
    const { rewardAccount } = buildInfoActionProposeParts({
      rewardAddressHex: REWARD_ADDRESS_HEX,
      anchorUrl: ANCHOR_URL,
      anchorHashHex: ANCHOR_HASH_HEX,
    });

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
