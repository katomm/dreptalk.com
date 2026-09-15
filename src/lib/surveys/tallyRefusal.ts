// Whether a survey's informational tally has figures to draw, and when it has
// none, the one named reason why. Pure.
//
// This lives outside the component because two places need the same answer: the
// tally renders either figures or the refusal sentence, and the card decides
// whether to render its own question list at all. A tally that draws bars
// already renders every question in full, prompt, kind and every option, so a
// second list above it would repeat the whole survey. Two copies of this
// decision could drift apart and leave a page with both lists or neither.

import { Role } from 'cip-179';
import type { SurveyLifecycle } from './state.js';

export interface TallyRefusalInput {
  unavailable: boolean;
  externalContent: boolean;
  sealed: boolean;
  finalState: string | null;
  artifactHash: string | null;
  eligibleRoles: readonly number[];
  lifecycle: SurveyLifecycle;
  /** Whether the stored definition decoded. Without it an answer cannot be
   * attributed to the question it belongs to. */
  definitionReadable: boolean;
  /** A stored reading computed from a different artifact than the survey now
   * names. Work in progress, never figures. */
  tallyStale: boolean;
  hasTally: boolean;
  /** Newest epoch the local power history holds, null when it holds nothing.
   * The only thing that tells an uncomputed reading apart from an uncomputable
   * one. */
  powerEpoch: number | null;
}

/**
 * One reason, and the most specific one first: the survey's own state outranks
 * the tally's, because a reading of a survey the index no longer holds, or that
 * CIP-179 never produced a tally for, is not made better by being fresh. The
 * stale guard then outranks a missing row, and an empty power history outranks
 * "not computed yet", since nothing can be computed without it.
 *
 * The survey-state sentences cover exactly the states the tally pass itself
 * refuses on (sync.ts, tallyOneSurvey), the unreadable definition included. A
 * state the pass refuses must never fall through to "not computed yet", which
 * would tell the reader to wait for a pass that is never coming.
 *
 * Returns null when there are figures to draw.
 */
export function tallyRefusal(s: TallyRefusalInput): string | null {
  // The same expression the tally pass refuses on, in src/lib/surveys/sync.ts: a
  // sealed survey is readable only once it is finalized AND carries an artifact
  // hash. Testing the hash alone would tell a reader to wait for a pass that
  // refuses this survey by design.
  const sealedWithoutArtifact =
    s.sealed && !(s.finalState === 'finalized' && s.artifactHash !== null);

  if (s.unavailable) {
    return 'This survey is no longer in the index, so the responses it had are no longer a record this site will read. No figures are shown.';
  }
  if (s.externalContent) {
    return 'This survey keeps its questions in an external document that is not loaded here, so its answers are not counted on this site.';
  }
  if (s.lifecycle === 'cancelled') {
    return 'This survey was cancelled by its creator, and CIP-179 produces no tally for a cancelled survey, so there is nothing to read.';
  }
  if (s.lifecycle === 'untalliable') {
    return "This survey's definition is invalid under CIP-179, so it was never talliable and no reading of it exists.";
  }
  if (!s.eligibleRoles.includes(Role.DRep)) {
    return 'This survey does not accept DRep responses, and a DRep reading is the only one this site counts.';
  }
  if (sealedWithoutArtifact) {
    return 'The answers to this survey are timelock-encrypted. They stay unreadable until it closes and its tally artifact is published, so no answer can be counted yet.';
  }
  if (!s.definitionReadable) {
    return "This survey's stored definition could not be read here, and without it an answer cannot be attributed to the question it belongs to, so the stored reading cannot be shown here.";
  }
  if (s.tallyStale) {
    return "These figures are being recomputed. The survey's tally artifact has changed, so the stored reading describes a different artifact than the survey now names, and showing it as current would be wrong.";
  }
  if (!s.hasTally) {
    return s.powerEpoch === null
      ? 'No reading yet: this site holds no DRep voting power history for this network, and a weighted reading cannot be computed without one.'
      : // True of both states the page cannot tell apart: a survey the pass has
        // not reached yet, and one it reached and whose bundle fetch keeps
        // failing. The queue's attempt counter would separate them, and the page
        // does not load it, so the sentence claims neither.
        'No reading computed yet. The sync pass that counts the responses has not produced one for this survey.';
  }
  return null;
}
