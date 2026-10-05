// The single mainnet switch for governance action submission. Every place
// that gates the submit form, its APIs, or its tx builders reads this one
// helper instead of its own literal preprod check, so turning mainnet on is
// one edit here plus the checklist in the spec's "Mainnet enablement"
// section (~/claude-notes/dreptalk/2026-09-18-gov-action-types-design.md),
// not a hunt through the tree for scattered guards.
import type { CardanoNetwork } from '@/lib/config/network.js';

export function govActionSubmissionAvailable(network: CardanoNetwork): boolean {
  return network === 'preprod';
}
