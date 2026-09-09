// Which surveys DRepTalk mirrors. Editorial policy, not a claim about the
// survey, and split along one line: what Tessera's answer alone decides is
// asked here, of every survey an answer names, and gives the survey a row.
// What only DRepTalk knows, whether a linking action is imported, is asked
// of the stored rows by getPublishableSurveys (src/lib/db/surveys.ts) and
// gives it a thread. Tessera re-delivers a survey whenever a fact on its side
// moves, so nothing about this half needs remembering. The other half can
// turn true with no move upstream, which is why it is never asked of a
// passing answer. Widening admission (the authored and imported gates agreed
// in the upstream issue) is a change to the two together.

import { Role } from 'cip-179';
import type { SurveyAggregate } from 'cip-179/domain';

/**
 * Tessera's half of admission: DReps may respond, the survey is linked by at
 * least one governance action, and neither of `aggregate()`'s two
 * definition-derived verdicts is against it, an untalliable definition (no
 * conformant reader counts its answers), or a sealed survey on a drand chain
 * the published tlock cannot decrypt (its answers stay encrypted forever and
 * Tessera decides it untalliable at close). Tessera's own app blocks
 * responding to either. A thread inviting answers would spend fees on them.
 * The sync stores a survey on this predicate and withdraws a held one on its
 * negation, so the two cannot disagree about what a mirrored survey is.
 */
export function eligibleSurvey(a: SurveyAggregate): boolean {
  return (
    a.record.definition.eligibleRoles.includes(Role.DRep) &&
    a.govLinks.length > 0 &&
    a.talliable &&
    !a.sealedUnsupported
  );
}
