// The single mainnet switch for governance action submission, plus the
// per-type availability on top of it. Every place that gates the submit form,
// its APIs, or its tx builders reads these helpers instead of its own literal
// network check, so turning mainnet on is one edit here plus the checklist in
// the spec's "Mainnet enablement" section
// (~/claude-notes/dreptalk/2026-09-18-gov-action-types-design.md), not a hunt
// through the tree for scattered guards.
import type { CardanoNetwork } from '@/lib/config/network.js';
import type { GovActionFormType } from './prevAction.js';

export function govActionSubmissionAvailable(network: CardanoNetwork): boolean {
  return network === 'preprod';
}

/** The switch's answer for this request, plus the network the type rules depend on. */
export interface TypeAvailabilityInput {
  submissionAvailable: boolean;
  network: CardanoNetwork;
}

/**
 * Whether a type can be submitted. Takes the switch's answer as a value
 * instead of computing it, so a caller that learns it from elsewhere (the
 * mainnet design passes it from the server with the session's roles) feeds
 * the same rule. Nothing is available where submission is off. Treasury
 * withdrawals run the constitution's guardrails script, wired and tested on
 * preprod only, so they stay unavailable on every other network whatever the
 * switch says.
 */
export function govActionTypeAvailable(type: GovActionFormType, input: TypeAvailabilityInput): boolean {
  if (!input.submissionAvailable) return false;
  if (type === 'TreasuryWithdrawals') return input.network === 'preprod';
  return true;
}
