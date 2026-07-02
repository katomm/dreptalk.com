// The seven on-chain governance action types (CIP-1694). Values are the verbatim
// Koios `proposal_type` strings stored in governance_actions.type; labels are the
// short forms shown in the overview type filter. This list is the single source of
// truth for both the dropdown and ?type= validation.
export const GOV_ACTION_TYPES: readonly { value: string; label: string }[] = [
  { value: 'InfoAction', label: 'Info' },
  { value: 'TreasuryWithdrawals', label: 'Treasury Withdrawal' },
  { value: 'ParameterChange', label: 'Parameter Change' },
  { value: 'HardForkInitiation', label: 'Hard Fork' },
  { value: 'NewConstitution', label: 'New Constitution' },
  { value: 'NewCommittee', label: 'New Committee' },
  { value: 'NoConfidence', label: 'No Confidence' },
];

const VALID = new Set<string>(GOV_ACTION_TYPES.map((t) => t.value));

/** Parses the ?type= param, returns the type when known, else null (equals all types). */
export function parseGovType(value: string | null): string | null {
  return value && VALID.has(value) ? value : null;
}
