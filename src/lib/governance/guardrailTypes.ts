// The action types whose proposal carries the constitution's guardrails script
// as a witness: a redeemer, collateral and an evaluation before signing. Pure
// and free of runtime imports, so the client bundle can use it.
import type { GovActionFormType } from './prevAction.js';

export const GUARDRAIL_FORM_TYPES: ReadonlySet<GovActionFormType> = new Set(['TreasuryWithdrawals', 'ParameterChange']);
