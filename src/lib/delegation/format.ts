// Human label for a delegation target, shared by the inbox and (Phase 5) the
// dashboard. A resolved DRep name is preferred; without one, a shortened id.
import type { DelegationState } from './resolve.js';

export function delegationLabel(state: DelegationState, drepName?: string | null): string {
  switch (state.type) {
    case 'abstain': return 'Always Abstain';
    case 'no_confidence': return 'Always No Confidence';
    case 'none': return 'no DRep';
    case 'drep': return drepName || `${state.drepId.slice(0, 12)}...`;
  }
}
