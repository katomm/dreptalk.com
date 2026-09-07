// Which surveys DRepTalk mirrors. Editorial policy, not a claim about the
// survey, and the one place it is written down: the sync admits a survey on
// this predicate and retires a held one on its negation, so the two passes
// cannot disagree about what an admitted survey is. Widening admission (the
// authored and imported gates agreed in the upstream issue) is a change here.

import { Role } from 'cip-179';
import type { SurveyAggregate } from 'cip-179/domain';

/**
 * The half of admission the definition alone decides, so it never changes for
 * a given record: DReps may respond, and neither of `aggregate()`'s two
 * definition-derived verdicts is against it — an untalliable definition (no
 * conformant reader counts its answers), or a sealed survey on a drand chain
 * the published tlock cannot decrypt (its answers stay encrypted forever and
 * Tessera decides it untalliable at close). Tessera's own app blocks
 * responding to either; a thread inviting answers would spend fees on them.
 */
export function eligibleSurvey(a: SurveyAggregate): boolean {
  return (
    a.record.definition.eligibleRoles.includes(Role.DRep) && a.talliable && !a.sealedUnsupported
  );
}

/** Admission: an eligible survey linked by a governance action DRepTalk has
 * imported. `imported` is the answer to "which of this aggregate's link ids
 * are imported", so a caller that has none to ask about passes an empty set. */
export function admissible(a: SurveyAggregate, imported: ReadonlySet<string>): boolean {
  return eligibleSurvey(a) && a.govLinks.some(l => imported.has(l.actionId));
}
