// The seven on-chain governance action types (CIP-1694). Values are the verbatim
// Koios `proposal_type` strings stored in governance_actions.type; labels are the
// short forms shown in the overview type filter; glossary is the id of the matching
// entry in src/content/glossary. This list is the single source of truth for the
// dropdown, ?type= validation, and per-type glossary links.
export const GOV_ACTION_TYPES: readonly { value: string; label: string; glossary: string }[] = [
  { value: 'InfoAction', label: 'Info Action', glossary: 'info-action' },
  { value: 'TreasuryWithdrawals', label: 'Treasury Withdrawal', glossary: 'treasury-withdrawal' },
  { value: 'ParameterChange', label: 'Parameter Change', glossary: 'protocol-parameter-change' },
  { value: 'HardForkInitiation', label: 'Hard Fork', glossary: 'hard-fork-initiation' },
  { value: 'NewConstitution', label: 'New Constitution', glossary: 'new-constitution' },
  { value: 'NewCommittee', label: 'New Committee', glossary: 'update-constitutional-committee' },
  { value: 'NoConfidence', label: 'No Confidence', glossary: 'motion-of-no-confidence' },
];

const VALID = new Set<string>(GOV_ACTION_TYPES.map((t) => t.value));

const GLOSSARY_BY_TYPE = new Map(GOV_ACTION_TYPES.map((t) => [t.value, t.glossary]));

/** Glossary entry id for a raw on-chain type, or null when the type is unknown. */
export function govTypeGlossarySlug(type: string): string | null {
  return GLOSSARY_BY_TYPE.get(type) ?? null;
}

/** Parses the ?type= param, returns the type when known, else null (equals all types). */
export function parseGovType(value: string | null): string | null {
  return value && VALID.has(value) ? value : null;
}
