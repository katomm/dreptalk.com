// Presentation helpers for mirrored CIP-179 surveys, shared by the survey
// pages and the sync's opening-post composer. Pure: everything derives from
// the stored row, the network config, and the wall clock — no chain read.

import { Role, type SurveyDefinition } from 'cip-179';
import type { SurveyRecord } from 'cip-179/domain';
import { fromJsonSafe } from 'cip-179/tally';
import { epochFromUnix, epochStartUnix, type NetworkConfig } from '../config/network.js';

export const ROLE_LABELS: Record<number, string> = {
  [Role.DRep]: 'DReps',
  [Role.SPO]: 'SPOs',
  [Role.CC]: 'Constitutional Committee members',
  [Role.Stakeholder]: 'stakeholders',
  [Role.Keyholder]: 'keyholders',
};

export function roleLabels(roles: readonly number[]): string {
  return roles.map((r) => ROLE_LABELS[r] ?? `role ${r}`).join(', ');
}

/** Decode a stored wire-form record back to its definition (the same
 * fromJsonSafe + cast Tessera's own consumers use). */
export function parseSurveyDefinition(definitionJson: string): SurveyDefinition {
  return (fromJsonSafe(JSON.parse(definitionJson)) as SurveyRecord).definition;
}

/**
 * Lifecycle from the wall clock: responses are accepted through `end_epoch`
 * inclusive (CIP-179), so the survey is open while the current epoch is at or
 * before it — the same rule as Tessera's surveyStatus, anchored on the
 * network's epoch calendar instead of a chain tip. `unavailable` is a separate
 * flag on the row, not a status: it clouds what is known, it doesn't end the
 * survey.
 */
export type SurveyLifecycle = 'open' | 'closed' | 'cancelled';

export function surveyLifecycle(
  row: { endEpoch: number; cancelled: boolean },
  nowMs: number,
  cfg: NetworkConfig,
): SurveyLifecycle {
  if (row.cancelled) return 'cancelled';
  return epochFromUnix(nowMs / 1000, cfg) > row.endEpoch ? 'closed' : 'open';
}

const LIFECYCLE_LABELS: Record<SurveyLifecycle, string> = {
  open: 'Open',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** Badge text for a lifecycle, so the row, the card and the sidebar card
 * cannot come to disagree about what a survey's state is called. */
export function lifecycleLabel(lifecycle: SurveyLifecycle): string {
  return LIFECYCLE_LABELS[lifecycle];
}

/**
 * What the participation line can say. Two figures, both Tessera's own
 * counting and never one of this site's: while the survey is held, the
 * index's audited in-window DRep count (provisional — a proof still pending
 * is counted, and a responder who leaves the role by the end epoch is not yet
 * excluded); once finalized, the tally artifact's DRep responders, counted
 * at close. `pending` says a figure is still coming: the backend serves no
 * in-window count yet, or the artifact has not been read. `none` says no
 * figure ever will: a cancelled or untalliable survey has no tally. A
 * rolled-back record is `unavailable` whatever it stored, since the count
 * describes a survey the index no longer has.
 */
export type SurveyParticipation =
  | { kind: 'counted'; count: number }
  | { kind: 'countedAtClose'; count: number }
  | { kind: 'pending' }
  | { kind: 'unavailable' }
  | { kind: 'none' };

export function surveyParticipation(row: {
  countedDreps: number | null;
  finalCountedDreps: number | null;
  finalState: string | null;
  unavailable: boolean;
}): SurveyParticipation {
  if (row.unavailable) return { kind: 'unavailable' };
  if (row.finalCountedDreps !== null) {
    return { kind: 'countedAtClose', count: row.finalCountedDreps };
  }
  if (row.finalState !== null && row.finalState !== 'finalized') return { kind: 'none' };
  if (row.countedDreps !== null) return { kind: 'counted', count: row.countedDreps };
  return { kind: 'pending' };
}

/** One wording for the participation line, so the row, the card and the
 * sidebar card cannot describe the same figure differently. */
export function participationLabel(p: SurveyParticipation): string {
  switch (p.kind) {
    case 'counted':
      return `${p.count} DRep ${p.count === 1 ? 'response' : 'responses'} counted`;
    case 'countedAtClose':
      return `${p.count} DRep ${p.count === 1 ? 'response' : 'responses'} counted at close`;
    case 'pending':
      return 'count pending';
    case 'unavailable':
      return 'count unavailable';
    case 'none':
      return 'no count';
  }
}

/** Unix seconds of the response cutoff: the start of the epoch after
 * `end_epoch` (inclusive deadline). */
export function surveyDeadlineUnix(endEpoch: number, cfg: NetworkConfig): number {
  return epochStartUnix(endEpoch + 1, cfg);
}

/** Deep link into the Tessera app's survey page, or null when no app origin
 * is configured for this deployment. */
export function tesseraSurveyUrl(appUrl: string | undefined, ref: string): string | null {
  if (!appUrl) return null;
  return `${appUrl.replace(/\/+$/, '')}/survey/${ref}`;
}

/** One question, flattened for rendering: what it asks, how it answers, and
 * its option labels (null in external-content count form, with a note). */
export interface QuestionView {
  prompt: string;
  kindLabel: string;
  options: string[] | null;
  optionNote: string | null;
  required: boolean;
}

export function questionViews(def: SurveyDefinition): QuestionView[] {
  return def.questions.map((q) => {
    const opts = 'options' in q ? q.options : null;
    return {
      prompt: q.prompt,
      kindLabel:
        q.type === 'singleChoice'
          ? 'Single choice'
          : q.type === 'multiSelect'
            ? `Select ${q.minSelections}–${q.maxSelections}`
            : q.type === 'ranking'
              ? `Rank ${q.minRanked}–${q.maxRanked}`
              : q.type === 'numericRange'
                ? `Number between ${q.constraints.min} and ${q.constraints.max}`
                : q.type === 'pointsAllocation'
                  ? `Distribute ${q.budget} points`
                  : q.type === 'rating'
                    ? 'Rate the options'
                    : 'Custom format',
      options: opts?.type === 'options' ? [...opts.labels] : null,
      optionNote:
        opts?.type === 'count' ? `${opts.count} options (labels in the external document)` : null,
      required: q.required === true,
    };
  });
}
