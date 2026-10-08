// Pure construction of the SDK's typed GovernanceAction value for every
// governance action type the submit form offers: the five unwitnessed types
// plus TreasuryWithdrawals, whose policy hash makes the ledger run the
// constitution's guardrails script (the redeemer and the script itself are
// added in govActionTx.ts), and ParameterChange, which carries the same policy
// hash for the same reason. No network access, so govActionTx.ts and its
// tests both depend on this leaf module for construction and keep signing and
// submission separate.

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
import type { GuardrailContext } from './guardrailScript.js';
import { buildParamUpdate } from './paramUpdate.js';
import type { ParamValues } from './paramDefs.js';

/** The typed inputs for every governance action this app can submit. */
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
    }
  | {
      type: 'TreasuryWithdrawals';
      /** One entry per recipient: the 29-byte reward address as hex, and the amount. */
      withdrawals: { rewardAddressHex: string; lovelace: bigint }[];
      /** The checked guardrail: a known hash becomes the policy hash, a proven absence leaves it null. */
      guardrail: GuardrailContext;
    }
  | {
      type: 'ParameterChange';
      prev: PrevActionRef | null;
      /** The checked values, canonical units (see paramDefs.ts). */
      values: ParamValues;
      guardrail: GuardrailContext;
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
 * Constructs the typed SDK GovernanceAction for every type in GovActionSpec.
 * Pure. Exported for unit tests.
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

    case 'TreasuryWithdrawals': {
      // The SDK keys the withdrawals map by RewardAccount object, and a JS Map
      // compares object keys by identity, so two rows for one address would
      // become two entries that encode as a duplicate map key. The rows are
      // keyed by the lowercase hex first, and a repeat is refused outright:
      // merging or dropping it would change an amount the user typed. The form
      // already rejects duplicates, this is the second line.
      const byAddress = new Map<string, bigint>();
      for (const withdrawal of spec.withdrawals) {
        const key = withdrawal.rewardAddressHex.toLowerCase();
        if (byAddress.has(key)) throw new Error(`Duplicate treasury withdrawal recipient ${key}.`);
        byAddress.set(key, withdrawal.lovelace);
      }
      const withdrawals = new Map<RewardAccount.RewardAccount, bigint>();
      for (const [hex, lovelace] of byAddress) withdrawals.set(RewardAccount.fromHex(hex), lovelace);
      return new GovernanceAction.TreasuryWithdrawalsAction({
        withdrawals,
        policyHash:
          spec.guardrail.state === 'known' ? ScriptHash.fromBytes(hexToBytes(spec.guardrail.scriptHash)) : null,
      });
    }

    case 'ParameterChange':
      return new GovernanceAction.ParameterChangeAction({
        govActionId: buildPrevGovActionId(spec.prev),
        protocolParamUpdate: buildParamUpdate(spec.values),
        policyHash:
          spec.guardrail.state === 'known' ? ScriptHash.fromBytes(hexToBytes(spec.guardrail.scriptHash)) : null,
      });
  }
}
