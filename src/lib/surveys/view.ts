// Presentation of a mirrored survey's definition text, shared by the survey
// pages and the sync's opening-post composer. Pure. What a survey *is*,
// lifecycle, answerability, participation, is decided in ./state.ts from the
// stored row. This module reads the definition, which is untrusted on-chain
// text: every string that reaches a page or a post goes through the same
// sanitizer and caps as a governance action's anchor text.

import { Role, type SurveyDefinition } from 'cip-179';
import { formatRelativeTime } from '../forum/view.js';
import { decodeSurveyRecord } from 'cip-179/tally';
import {
  MAX_EXTERNAL_PROSE_LEN,
  MAX_EXTERNAL_TITLE_LEN,
  sanitizeExternalMultiline,
  sanitizeExternalText,
} from '../validation/input.js';

/**
 * One wording for the freshness line, so the category list and the two cards
 * cannot describe the same snapshot differently. Callers decide whether there
 * is a line at all: an undated mirror has nothing honest to say about itself.
 *
 * `incomplete` is the source's own report that the scan behind the snapshot
 * read only part of the matching records. It is a separate fact from the age:
 * a snapshot can be minutes old and still short, and a count taken from it is
 * then a floor, not a total. Saying only how fresh it is would present the
 * undercount as whole.
 */
export function freshnessLine(asOfSeconds: number, incomplete: boolean, nowMs: number): string {
  const age = `Survey data as of ${formatRelativeTime(asOfSeconds * 1000, nowMs)}. Cached, not live.`;
  return incomplete
    ? `${age} The source read only part of the records for this snapshot, so counts may be low.`
    : age;
}

export const ROLE_LABELS: Record<number, string> = {
  [Role.DRep]: 'DReps',
  [Role.SPO]: 'SPOs',
  [Role.CC]: 'Constitutional Committee members',
  [Role.Stakeholder]: 'stakeholders',
  [Role.Keyholder]: 'keyholders',
};

export function roleLabels(roles: readonly number[]): string {
  return roles.map(r => ROLE_LABELS[r] ?? `role ${r}`).join(', ');
}

/**
 * Decode a stored wire-form record back to its definition, or null when the
 * stored form cannot be read. The form is frozen at admission and decoded on
 * every page view, so a shape this code cannot read, a corrupted row, a
 * cip-179 wire change the mirror predates, must cost the card its text and
 * the page its answer panel, not the whole thread a 500.
 */
export function parseSurveyDefinition(definitionJson: string): SurveyDefinition | null {
  try {
    return decodeSurveyRecord(JSON.parse(definitionJson)).definition;
  } catch {
    return null;
  }
}

/** Thread and row title: the on-chain title, sanitized and capped like a
 * governance action's, or a ref-derived fallback (empty titles are legal in
 * external-content mode). */
export function surveyTitle(def: SurveyDefinition, ref: string): string {
  const title = sanitizeExternalText(def.title, MAX_EXTERNAL_TITLE_LEN);
  if (title) return title;
  const [txHash, index] = ref.split(':');
  return `Survey (${txHash.slice(0, 8)}:${index})`;
}

/** The description as the card and the opening post show it: sanitized and
 * capped like an action's abstract. Empty when the definition carries none. */
export function surveyDescription(def: SurveyDefinition): string {
  return sanitizeExternalMultiline(def.description, MAX_EXTERNAL_PROSE_LEN);
}

/** Deep link into the Tessera app's survey page, or null when no app origin
 * is configured for this deployment. */
export function tesseraSurveyUrl(appUrl: string | undefined, ref: string): string | null {
  if (!appUrl) return null;
  return `${appUrl.replace(/\/+$/, '')}/survey/${ref}`;
}

/** One question, flattened for rendering: what it asks, how it answers, and
 * its option labels (null in external-content count form, with a note).
 * Prompts and labels are sanitized here, at render: the stored record is the
 * widget's, re-decoded as cip-179 serialized it, so it is never sanitized or
 * capped, the text derived from it is. */
export interface QuestionView {
  prompt: string;
  kindLabel: string;
  options: string[] | null;
  optionNote: string | null;
  required: boolean;
}

export function questionViews(def: SurveyDefinition): QuestionView[] {
  return def.questions.map(q => {
    const opts = 'options' in q ? q.options : null;
    return {
      prompt: sanitizeExternalText(q.prompt, MAX_EXTERNAL_TITLE_LEN),
      kindLabel:
        q.type === 'singleChoice'
          ? 'Single choice'
          : q.type === 'multiSelect'
            ? `Select ${q.minSelections} to ${q.maxSelections}`
            : q.type === 'ranking'
              ? `Rank ${q.minRanked} to ${q.maxRanked}`
              : q.type === 'numericRange'
                ? `Number between ${q.constraints.min} and ${q.constraints.max}`
                : q.type === 'pointsAllocation'
                  ? `Distribute ${q.budget} points`
                  : q.type === 'rating'
                    ? 'Rate the options'
                    : 'Custom format',
      options:
        opts?.type === 'options'
          ? opts.labels.map(l => sanitizeExternalText(l, MAX_EXTERNAL_TITLE_LEN))
          : null,
      optionNote:
        opts?.type === 'count' ? `${opts.count} options (labels in the external document)` : null,
      required: q.required === true,
    };
  });
}
