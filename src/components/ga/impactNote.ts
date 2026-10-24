// The estimate sentence above the impact charts. It says which data the
// figures come from: today's for an open action, the basis epoch's otherwise.
import type { ImpactOutcome } from '@/lib/governance/basisEpoch.js';

export function impactNote(outcome: ImpactOutcome, withPools: boolean, epoch: number | null): string {
  // A decided proposal without a basis epoch should not occur, so it reads like an open one.
  if (outcome === 'enacted' && epoch !== null) {
    return withPools
      ? `What this change did, computed from the pool distribution and parameters of epoch ${epoch} before it took effect, so read it as an estimate.`
      : `What this change did, computed from the parameters of epoch ${epoch} before it took effect, so read it as an estimate.`;
  }
  if (outcome === 'ended' && epoch !== null) {
    return withPools
      ? `What it would have done, computed from the pool distribution and parameters of epoch ${epoch}, so read it as an estimate.`
      : `What it would have done, computed from the parameters of epoch ${epoch}, so read it as an estimate.`;
  }
  return withPools
    ? 'What the proposed values would do, computed from the current pool distribution and parameters, so read them as an estimate.'
    : 'What the proposed values would do, computed from the current parameters, so read them as an estimate.';
}
