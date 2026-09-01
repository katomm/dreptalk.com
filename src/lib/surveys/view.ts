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

/** Whether a row storing no count can still gain one. False once a decided
 * survey's audit schedule closes without one: "pending" would be a lie, since
 * nothing is scheduled any more. */
export function countStillExpected(row: {
  finalState: string | null;
  auditDueAt: number | null;
}): boolean {
  return row.finalState === null || row.auditDueAt !== null;
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
