import type { ProposalListRow } from '../../koios/client.js';

// Minimal Koios proposal_list row for the lifecycle tests: only the identity
// fields, everything lifecycle-related comes from `over`.
export function lifeRow(txHash: string, over: Partial<ProposalListRow> = {}): ProposalListRow {
  return {
    proposal_id: `gov_${txHash}`,
    proposal_tx_hash: txHash,
    proposal_index: 0,
    proposal_type: 'TreasuryWithdrawals',
    ...over,
  } as ProposalListRow;
}
