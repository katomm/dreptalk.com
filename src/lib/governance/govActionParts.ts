// Pure construction of the SDK's typed GovernanceAction value for each of the
// five unwitnessed Conway governance action types (everything except
// ParameterChangeAction and TreasuryWithdrawalsAction, which need a wallet
// signer or protocol-parameter tooling this app does not yet build). No
// network access required, so govActionTx.ts and its tests both depend on
// this leaf module for construction and keep signing/submission separate.

import {
  Anchor,
  Constitution,
  GovernanceAction,
  KeyHash,
  RewardAccount,
  ScriptHash,
  UnitInterval,
  Url,
  ProtocolVersion,
} from '@evolution-sdk/evolution';
import { buildGovActionId } from './drepTx.js';
import { formatGovActionKey, type PrevActionRef } from './prevAction.js';
import type { ColdCredential } from './committeeUpdate.js';
import { hexToBytes } from '../crypto/hex.js';

/** The typed inputs for every unwitnessed Conway governance action this app can submit. */
export type GovActionSpec =
  | { type: 'InfoAction' }
  | { type: 'NoConfidence'; prev: PrevActionRef | null }
  | { type: 'HardForkInitiation'; prev: PrevActionRef | null; version: { major: number; minor: number } }
  | {
      type: 'NewConstitution';
      prev: PrevActionRef | null;
      anchorUrl: string;
      anchorHashHex: string;
      scriptHashHex: string | null;
    }
  | {
      type: 'UpdateCommittee';
      prev: PrevActionRef | null;
      remove: ColdCredential[];
      add: { credential: ColdCredential; expiryEpoch: number }[];
      quorum: { numerator: number; denominator: number };
    };

/** Builds the SDK GovActionId from a PrevActionRef, or null when the chain has no prior root. */
function buildPrevGovActionId(prev: PrevActionRef | null): GovernanceAction.GovActionId | null {
  return prev === null ? null : buildGovActionId(formatGovActionKey(prev));
}

/** Builds a committee cold credential (key hash or script hash) from its hex form. */
function buildColdCredential(credential: ColdCredential): KeyHash.KeyHash | ScriptHash.ScriptHash {
  const bytes = hexToBytes(credential.hashHex);
  return credential.isScript ? ScriptHash.fromBytes(bytes) : KeyHash.fromBytes(bytes);
}

/**
 * Constructs the typed SDK GovernanceAction for any of the five unwitnessed
 * action types from a GovActionSpec. Pure; exported for unit tests.
 */
export function buildGovernanceAction(spec: GovActionSpec): GovernanceAction.GovernanceAction {
  switch (spec.type) {
    case 'InfoAction':
      return new GovernanceAction.InfoAction({});

    case 'NoConfidence':
      return new GovernanceAction.NoConfidenceAction({
        govActionId: buildPrevGovActionId(spec.prev),
      });

    case 'HardForkInitiation':
      return new GovernanceAction.HardForkInitiationAction({
        govActionId: buildPrevGovActionId(spec.prev),
        protocolVersion: new ProtocolVersion.ProtocolVersion({
          major: BigInt(spec.version.major),
          minor: BigInt(spec.version.minor),
        }),
      });

    case 'NewConstitution':
      return new GovernanceAction.NewConstitutionAction({
        govActionId: buildPrevGovActionId(spec.prev),
        constitution: new Constitution.Constitution({
          anchor: new Anchor.Anchor({
            anchorUrl: new Url.Url({ href: spec.anchorUrl }),
            anchorDataHash: hexToBytes(spec.anchorHashHex),
          }),
          scriptHash: spec.scriptHashHex === null ? null : ScriptHash.fromBytes(hexToBytes(spec.scriptHashHex)),
        }),
      });

    case 'UpdateCommittee': {
      const membersToAdd = new Map<KeyHash.KeyHash | ScriptHash.ScriptHash, bigint>();
      for (const member of spec.add) {
        membersToAdd.set(buildColdCredential(member.credential), BigInt(member.expiryEpoch));
      }
      return new GovernanceAction.UpdateCommitteeAction({
        govActionId: buildPrevGovActionId(spec.prev),
        membersToRemove: spec.remove.map(buildColdCredential),
        membersToAdd,
        threshold: new UnitInterval.UnitInterval({
          numerator: BigInt(spec.quorum.numerator),
          denominator: BigInt(spec.quorum.denominator),
        }),
      });
    }
  }
}

/**
 * Pure helper: constructs the typed RewardAccount, GovernanceAction, and Anchor
 * values for an InfoAction proposal from the raw inputs. No network access
 * required. Exported for unit tests that verify construction without a live
 * wallet.
 */
export function buildInfoActionProposeParts(opts: {
  rewardAddressHex: string;
  anchorUrl: string;
  anchorHashHex: string;
}): { rewardAccount: RewardAccount.RewardAccount; governanceAction: GovernanceAction.InfoAction; anchor: Anchor.Anchor } {
  return {
    rewardAccount: RewardAccount.fromHex(opts.rewardAddressHex),
    governanceAction: new GovernanceAction.InfoAction({}),
    anchor: new Anchor.Anchor({
      anchorUrl: new Url.Url({ href: opts.anchorUrl }),
      anchorDataHash: hexToBytes(opts.anchorHashHex),
    }),
  };
}
