// What a mirrored survey is and what may be done with it, decided once from
// the stored row, the network calendar and the wall clock — no chain read.
// Every reader (the list row, the thread card, the action's sidebar card, the
// answer gate on the page and in the record API) renders from this, so no
// two of them can disagree about a survey's state.

import { Role } from 'cip-179';
import { epochFromUnix, type NetworkConfig } from '../config/network.js';

/**
 * Responses are accepted through `end_epoch` inclusive (CIP-179), so the
 * survey is open while the current epoch is at or before it — the same rule
 * as Tessera's surveyStatus, anchored on the network's epoch calendar instead
 * of a chain tip. A decision Tessera made outranks the clock: an untalliable
 * definition was never a valid survey (Tessera's own precedence, invalidity
 * before cancellation), and a verified cancellation ends it early.
 * `unavailable` is a separate axis, not a lifecycle: it clouds what is known,
 * it doesn't end the survey.
 */
export type SurveyLifecycle = 'open' | 'closed' | 'cancelled' | 'untalliable';

const LIFECYCLE_LABELS: Record<SurveyLifecycle, string> = {
  open: 'Open',
  closed: 'Closed',
  cancelled: 'Cancelled',
  untalliable: 'Invalid definition',
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
 * withdrawn record is `unavailable` whatever it stored, since the count
 * describes a survey the index no longer has.
 */
export type SurveyParticipation =
  | { kind: 'counted'; count: number }
  | { kind: 'countedAtClose'; count: number }
  | { kind: 'pending' }
  | { kind: 'unavailable' }
  | { kind: 'none' };

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

/** The columns the state derives from — a `SurveyRow`, or any row-shaped
 * object carrying them. */
export interface SurveyStateInput {
  endEpoch: number;
  eligibleRoles: readonly number[];
  cancelled: boolean;
  externalContent: boolean;
  countedDreps: number | null;
  finalCountedDreps: number | null;
  finalState: string | null;
  unavailable: boolean;
}

export interface SurveyState {
  lifecycle: SurveyLifecycle;
  /**
   * Whether the survey itself can take a DRep answer now: open, still held
   * by the index, DRep-eligible, and not external-content (its prompts live
   * behind an anchor Tessera's API does not serve, so the widget could not
   * show what is being signed). What the *viewer* and the *deployment* add —
   * a key-credential DRep session, the mirror configured, the stored
   * definition readable — stays with the page and the record API, which are
   * the only places that know it.
   */
  answerable: boolean;
  participation: SurveyParticipation;
}

export function surveyState(row: SurveyStateInput, nowMs: number, cfg: NetworkConfig): SurveyState {
  const lifecycle: SurveyLifecycle =
    row.finalState === 'untalliable'
      ? 'untalliable'
      : row.cancelled
        ? 'cancelled'
        : epochFromUnix(nowMs / 1000, cfg) > row.endEpoch
          ? 'closed'
          : 'open';
  return {
    lifecycle,
    answerable:
      lifecycle === 'open' &&
      !row.unavailable &&
      !row.externalContent &&
      row.eligibleRoles.includes(Role.DRep),
    participation: participation(row),
  };
}

function participation(row: SurveyStateInput): SurveyParticipation {
  if (row.unavailable) return { kind: 'unavailable' };
  if (row.finalCountedDreps !== null) {
    return { kind: 'countedAtClose', count: row.finalCountedDreps };
  }
  if (row.finalState !== null && row.finalState !== 'finalized') return { kind: 'none' };
  if (row.countedDreps !== null) return { kind: 'counted', count: row.countedDreps };
  return { kind: 'pending' };
}
