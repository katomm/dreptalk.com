// Presentation of a mirrored survey's definition text, shared by the survey
// pages and the sync's opening-post composer. Pure. What a survey *is* —
// lifecycle, answerability, participation — is decided in ./state.ts from the
// stored row; this module reads the definition, which is untrusted on-chain
// text: every string that reaches a page or a post goes through the same
// sanitizer and caps as a governance action's anchor text.

import { Role, type SurveyDefinition } from 'cip-179';
import type { SurveyRecord } from 'cip-179/domain';
import { fromJsonSafe } from 'cip-179/tally';
import { epochStartUnix, type NetworkConfig } from '../config/network.js';
import {
  MAX_EXTERNAL_PROSE_LEN,
  MAX_EXTERNAL_TITLE_LEN,
  sanitizeExternalMultiline,
  sanitizeExternalText,
} from '../validation/input.js';

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

/**
 * Decode a stored wire-form record back to its definition (the same
 * fromJsonSafe + cast Tessera's own consumers use), or null when the stored
 * form cannot be read. The form is frozen at admission and decoded on every
 * page view, so a shape this code cannot read — a corrupted row, a cip-179
 * wire change the mirror predates — must cost the card its text and the
 * page its answer panel, not the whole thread a 500. fromJsonSafe throws only
 * on bad hex and otherwise revives whatever it is given, so the shape is
 * checked as far as the readers go: the fields the card and the widget index
 * into.
 */
export function parseSurveyDefinition(definitionJson: string): SurveyDefinition | null {
  try {
    const record = fromJsonSafe(JSON.parse(definitionJson)) as Partial<SurveyRecord> | null;
    const def = record?.definition as Partial<SurveyDefinition> | undefined;
    if (
      !def ||
      typeof def !== 'object' ||
      typeof def.title !== 'string' ||
      typeof def.endEpoch !== 'number' ||
      !Array.isArray(def.eligibleRoles) ||
      !Array.isArray(def.questions) ||
      !def.submissionMode
    ) {
      return null;
    }
    return def as SurveyDefinition;
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
 * its option labels (null in external-content count form, with a note).
 * Prompts and labels are capped here, at render, because the stored
 * definition must stay verbatim — the widget re-decodes it, and its byte
 * fields would not survive a rewrite. */
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
      prompt: sanitizeExternalText(q.prompt, MAX_EXTERNAL_TITLE_LEN),
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
