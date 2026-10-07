// Which guardrails script the constitution in force requires, decided from
// the two kinds of ratified rows that prove it: a NewConstitution (the hash it
// set directly) and a ParameterChange or TreasuryWithdrawals (the policy hash
// the ledger required it to carry). The newer ratified row decides, a tie goes
// to the constitution row. The deciding row's own slot is the answer, and an
// unreadable deciding row is unknown rather than a fallback to the older row,
// since the older row may describe a constitution that is no longer in force.
// Pure, shared by the context route and the live test.
import { parseConstitutionScriptHash, parseProposalPolicyHash, type GuardrailLeaf } from './onchain.js';
import type { GuardrailContext } from './guardrailScript.js';
import type { ProposalListRow } from '../koios/client.js';

/** A guardrail the route can report, or one nothing on chain proves. */
export type GuardrailPick = GuardrailContext | { state: 'unknown' };

function fromLeaf(leaf: GuardrailLeaf): GuardrailPick {
  if (leaf.kind === 'hash') return { state: 'known', scriptHash: leaf.hex };
  if (leaf.kind === 'none') return { state: 'absent' };
  return { state: 'unknown' };
}

export function pickConstitutionScriptHash(
  constitutionRow: ProposalListRow | null,
  policyRow: ProposalListRow | null,
): GuardrailPick {
  const constitutionEpoch = constitutionRow?.ratified_epoch ?? null;
  const policyEpoch = policyRow?.ratified_epoch ?? null;
  if (policyRow && policyEpoch !== null && (constitutionEpoch === null || policyEpoch > constitutionEpoch)) {
    return fromLeaf(parseProposalPolicyHash(policyRow.proposal_description));
  }
  if (constitutionRow && constitutionEpoch !== null) {
    return fromLeaf(parseConstitutionScriptHash(constitutionRow.proposal_description));
  }
  // Nothing ratified on either side: the constitution in force came from the
  // Conway bootstrap and no row on chain says which script it carries.
  return { state: 'unknown' };
}
