// Which surveys DRepTalk mirrors. Editorial policy, not a claim about the
// survey, and the one place it is written down: the sync admits a survey on
// this predicate and retires a held one on its negation, so the two passes
// cannot disagree about what an admitted survey is. Widening admission (the
// authored and imported gates agreed in the upstream issue) is a change here.

import { Role } from 'cip-179';
import type { SurveyAggregate } from 'cip-179/domain';
import { isQuicknet } from 'cip-179/tlock';

/**
 * The half of admission the definition alone decides, so it never changes for
 * a given record: DReps may respond; the definition is spec-valid enough to
 * tally (`aggregate()` badges an invalid one untalliable and Tessera's own app
 * blocks responding to it — answering would spend a fee on a survey no
 * conformant reader counts); and a sealed survey is on the drand chain the
 * published tlock can decrypt, since answers to any other chain stay
 * encrypted forever and Tessera decides such a survey untalliable at close
 * without `aggregate()` saying so beforehand.
 */
export function eligibleSurvey(a: SurveyAggregate): boolean {
  const def = a.record.definition;
  if (!def.eligibleRoles.includes(Role.DRep)) return false;
  if (!a.talliable) return false;
  const mode = def.submissionMode;
  return mode.type !== 'sealed' || isQuicknet(mode.chainHash);
}

/** Admission: an eligible survey linked by a governance action DRepTalk has
 * imported. `imported` is the answer to "which of this aggregate's link ids
 * are imported", so a caller that has none to ask about passes an empty set. */
export function admissible(a: SurveyAggregate, imported: ReadonlySet<string>): boolean {
  return eligibleSurvey(a) && a.govLinks.some(l => imported.has(l.actionId));
}
