// Transactions built straight from SDK classes for the evaluate route, the
// evaluator adapter and the witness merge tests. Not valid on chain (one made
// up input, no outputs), but exactly the shapes the route decodes: proposals,
// redeemers and Plutus scripts in the witness set.
import {
  Anchor,
  Data,
  GovernanceAction,
  PlutusV3,
  ProposalProcedure,
  ProposalProcedures,
  Redeemer,
  Redeemers,
  RewardAccount,
  ScriptDataHash,
  ScriptHash,
  Transaction,
  TransactionBody,
  TransactionHash,
  TransactionInput,
  TransactionWitnessSet,
  Url,
} from '@evolution-sdk/evolution';
import { encodeBech32 } from '../../crypto/bech32.js';
import { hexToBytes } from '../../crypto/hex.js';
import { guardrailPlutusScript } from '../guardrailPlutusScript.js';
import { GUARDRAIL_SCRIPT_HASH_HEX } from '../guardrailScript.js';

export const FIXTURE_RECIPIENT = encodeBech32('stake_test', hexToBytes(`e0${'ab'.repeat(28)}`));

export function guardrailPlutusFixture(): PlutusV3.PlutusV3 {
  return guardrailPlutusScript();
}

/** Any other bytes: a Plutus script whose hash is not the guardrail's. */
export const FOREIGN_PLUTUS_SCRIPT = new PlutusV3.PlutusV3({ bytes: hexToBytes('4e4d01000033222220051200120011') });

const ANCHOR = new Anchor.Anchor({ anchorUrl: new Url.Url({ href: 'ipfs://fixture' }), anchorDataHash: new Uint8Array(32) });

function proposal(action: GovernanceAction.GovernanceAction): ProposalProcedure.ProposalProcedure {
  return new ProposalProcedure.ProposalProcedure({
    deposit: 1_000_000_000n,
    rewardAccount: RewardAccount.fromBech32(FIXTURE_RECIPIENT),
    governanceAction: action,
    anchor: ANCHOR,
  });
}

export function treasuryProposal(policyHashHex: string | null = GUARDRAIL_SCRIPT_HASH_HEX): ProposalProcedure.ProposalProcedure {
  return proposal(
    new GovernanceAction.TreasuryWithdrawalsAction({
      withdrawals: new Map([[RewardAccount.fromBech32(FIXTURE_RECIPIENT), 1_000_000n]]),
      policyHash: policyHashHex === null ? null : ScriptHash.fromHex(policyHashHex),
    }),
  );
}

export function infoProposal(): ProposalProcedure.ProposalProcedure {
  return proposal(new GovernanceAction.InfoAction({}));
}

/**
 * A transaction hex with the given proposals (default: one guardrail-checked
 * treasury withdrawal), one redeemer per tag (default: one propose redeemer
 * with ExUnits 1234 and 5678) and the given Plutus V3 scripts (default: the
 * guardrail).
 */
export function buildEvalTxHex(
  opts: {
    proposals?: ProposalProcedure.ProposalProcedure[];
    redeemerTags?: Redeemer.RedeemerTag[];
    scripts?: PlutusV3.PlutusV3[];
    scriptDataHashHex?: string;
  } = {},
): string {
  const proposals = opts.proposals ?? [treasuryProposal()];
  const redeemers = (opts.redeemerTags ?? ['propose']).map(
    (tag, i) =>
      new Redeemer.Redeemer({
        tag,
        index: BigInt(i),
        data: Data.constr(0n, []),
        exUnits: new Redeemer.ExUnits({ mem: 1234n, steps: 5678n }),
      }),
  );
  const scripts = opts.scripts ?? [guardrailPlutusFixture()];
  const body = new TransactionBody.TransactionBody({
    inputs: [new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex('11'.repeat(32)), index: 0n })],
    outputs: [],
    fee: 200_000n,
    ...(proposals.length > 0 ? { proposalProcedures: new ProposalProcedures.ProposalProcedures({ procedures: proposals }) } : {}),
    ...(opts.scriptDataHashHex ? { scriptDataHash: ScriptDataHash.fromHex(opts.scriptDataHashHex) } : {}),
  });
  const witnessSet = new TransactionWitnessSet.TransactionWitnessSet({
    ...(redeemers.length > 0 ? { redeemers: Redeemers.makeRedeemerMap(redeemers) } : {}),
    ...(scripts.length > 0 ? { plutusV3Scripts: scripts } : {}),
  });
  return Transaction.toCBORHex(new Transaction.Transaction({ body, witnessSet, isValid: true, auxiliaryData: null }));
}
