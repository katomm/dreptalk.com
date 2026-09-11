// The informational tally of one survey, as a pure function of its definition,
// its on-chain responses, the serving tier's proof verdicts and a local power
// lookup. No D1, no fetch, no clock, so every rule below is testable in
// isolation.
//
// Not one counting rule here is ours: auditResponses decides what counts,
// its dedup decides which of several responses from one credential wins,
// and weightedTallySurvey does the aggregation. We choose the responder sets and
// the weights, nothing else.
//
// Why two tally runs, since ArtifactQuestion already carries count AND weight
// per option: the runs differ in their responder SET, not in their reading. A
// counted DRep we cannot resolve to a local power row must leave the weighted
// run, and the head count must survive that, so the unit-weight run over every
// counted responder is the head count of record.
import { Role, type SurveyDefinition } from 'cip-179';
import {
  auditResponses,
  bytesToHex,
  credentialKey,
  type ExclusionKey,
  type ProofVerdicts,
  type ResponseRecord,
} from 'cip-179/domain';
import {
  toArtifactQuestions,
  weightedTallySurvey,
  type ArtifactRoleTally,
  type WeightedResponder,
} from 'cip-179/tally';
import type { PowerLookup } from '../db/drepPower.js';
import type { NewSurveyTally } from '../db/surveyTally.js';

/** The DRep role's committed tally plus the epoch it was weighted at. */
export interface ArtifactInput {
  role: ArtifactRoleTally;
  /** The survey's end_epoch, from the artifact's own tally body. */
  endEpoch: number;
}

export interface ComputeArgs {
  definition: SurveyDefinition;
  responses: readonly ResponseRecord[];
  verdicts: ProofVerdicts | undefined;
  power: PowerLookup;
  /**
   * The survey's tally artifact, when one exists: the DRep role's whole tally
   * plus the end epoch it was weighted at. Present means every weighted figure
   * is the hash-committed one. The head count and the exclusions stay ours,
   * because an artifact carries neither, except for a sealed survey (below).
   *
   * A role ABSENT from the artifact's perRole is not an absent artifact: it
   * means zero counted responders, which is how Pass 3 already reads it. The
   * caller passes an ArtifactInput whose role has an empty responder list in
   * that case, never null.
   */
  artifact: ArtifactInput | null;
  /**
   * Whether the survey's answers are timelock-encrypted. A sealed survey has no
   * readable per-question distribution before the reveal, and the reveal is out
   * of scope, so its head-count questions are the artifact's own and
   * headcountSource says 'artifact'. A sealed survey with no artifact never
   * reaches this function.
   */
  sealed: boolean;
}

export type ComputedTally = Omit<
  NewSurveyTally,
  'surveyRef' | 'bundleFetchedAt' | 'computedAt' | 'expectedArtifactHash'
>;

/** The bare credential hash of a response, the form Koios puts in dreps.hex. */
function credentialHashHex(r: ResponseRecord): { hex: string; isScript: boolean } {
  const c = r.response.credential;
  return c.type === 'key'
    ? { hex: bytesToHex(c.keyHash), isScript: false }
    : { hex: bytesToHex(c.scriptHash), isScript: true };
}

function responderOf(r: ResponseRecord, weight: bigint): WeightedResponder {
  return {
    credentialKey: credentialKey(r.response.credential),
    weight,
    txHash: r.txHash,
    responseIndex: r.responseIndex,
    response: r.response,
  };
}

export function computeSurveyTally(args: ComputeArgs): ComputedTally {
  const { definition, responses, verdicts, power, artifact, sealed } = args;

  // One audit over every response, whatever its claimed role: the exclusion
  // reasons are the library's and we only narrow the set afterwards.
  const audit = auditResponses(responses, definition, verdicts);

  const countedDreps = audit.counted.filter(r => r.response.role === Role.DRep);

  // Run A: every counted DRep at unit weight. The head count of record, and the
  // only run an unresolvable DRep appears in.
  //
  // A sealed survey is the exception: auditResponses counts a sealed response
  // for participation but cannot see its answers, so run A would produce empty
  // questions. Its head-count questions are the artifact's own instead, which is
  // a post-membership set, and headcountSource records that so the card can say
  // the figures describe the counted set at close.
  const headResponders = countedDreps.map(r => responderOf(r, 1n));
  const headcount =
    sealed && artifact !== null
      ? [...artifact.role.questions]
      : toArtifactQuestions(weightedTallySurvey(definition, headResponders));

  // Run B: only the DReps a local power row could be found for. A null weight
  // leaves the run, 0n stays in it.
  const weightedResponders: WeightedResponder[] = [];
  let answered = 0n;
  for (const r of countedDreps) {
    const { hex, isScript } = credentialHashHex(r);
    const w = power.weightOf(hex, isScript);
    if (w === null) continue;
    weightedResponders.push(responderOf(r, w));
    answered += w;
  }

  // Every weighted figure comes from one source or the other, never mixed. An
  // artifact was weighted at the survey's end epoch against that epoch's
  // electorate, so pairing its weights with today's denominator or today's
  // participant set would describe two different moments at once.
  //
  // answeredPower is summed over the artifact's RESPONDERS. There is no
  // survey-level answeredWeight to read it out of: each question commits its
  // own, and two responders answering two different optional questions give two
  // question weights whose maximum is smaller than the participating power.
  const weighted =
    artifact !== null
      ? [...artifact.role.questions]
      : toArtifactQuestions(weightedTallySurvey(definition, weightedResponders));

  const answeredPower =
    artifact !== null
      ? artifact.role.responders.reduce((sum, r) => sum + BigInt(r.weight), 0n)
      : answered;
  const matchedCount =
    artifact !== null ? artifact.role.responders.length : weightedResponders.length;
  const powerEpoch = artifact !== null ? artifact.endEpoch : power.epoch;
  const totalPower = artifact !== null ? artifact.role.total : power.totalPower;

  // Exclusions, narrowed to the DRep claim so they sit on the same axis as the
  // head count. Claimed, not verified: a record excluded for naming an
  // ineligible role has no other role to be counted under.
  const excludedDreps = audit.excludedRecords.filter(e => e.record.response.role === Role.DRep);
  const excludedBy: Partial<Record<ExclusionKey, number>> = {};
  for (const e of excludedDreps) excludedBy[e.key] = (excludedBy[e.key] ?? 0) + 1;

  // Every counted response per claimed role, for the line naming that other
  // roles responded. Derived from the responses, never from eligible_roles:
  // admission proves permission, never participation.
  const roleCounts: Record<number, number> = {};
  for (const r of audit.counted) {
    roleCounts[r.response.role] = (roleCounts[r.response.role] ?? 0) + 1;
  }
  const onlyDreps = Object.keys(roleCounts).every(k => Number(k) === Role.DRep);

  return {
    weightedSource: artifact !== null ? 'artifact' : 'live',
    headcountSource: sealed && artifact !== null ? 'artifact' : 'audit',
    artifactHash: null,
    powerEpoch,
    questions: { headcount, weighted },
    counted: countedDreps.length,
    matchedCount,
    answeredPower: answeredPower.toString(),
    totalPower,
    excluded: excludedDreps.length,
    excludedBy,
    roleCounts: onlyDreps ? null : roleCounts,
  };
}
