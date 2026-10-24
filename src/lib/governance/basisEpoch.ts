// The epoch whose parameters and pool data an impact section describes.
// Leaf module with no imports: the page, the pool read and the island share it.

/** open is active or ratified, ended is expired or dropped. */
export type ImpactOutcome = 'open' | 'enacted' | 'ended';

/** The action fields the basis rule reads. */
export interface BasisInput {
  status: string;
  decidedEpoch: number | null;
  ratifiedEpoch: number | null;
  enactedEpoch: number | null;
  expiryEpoch: number | null;
}

// Differs from classificationEndEpoch in voteTrendAssembly.ts on purpose: this is
// the last epoch before the outcome took effect (parameters and pool data), not
// the epoch that ends vote classification.
/**
 * The epoch the parameters were in force for the proposal: the ratified epoch
 * for a ratified action, the epoch before the decision otherwise. Null for an
 * active action or when the needed epoch column is missing.
 */
export function basisEpoch(a: BasisInput): number | null {
  const before = (epoch: number | null) => (epoch === null ? null : epoch - 1);
  switch (a.status) {
    case 'ratified':
      return a.ratifiedEpoch;
    case 'enacted':
      return before(a.enactedEpoch ?? a.decidedEpoch);
    case 'expired':
      return before(a.expiryEpoch ?? a.decidedEpoch);
    case 'dropped':
      return before(a.decidedEpoch);
    default:
      return null;
  }
}
