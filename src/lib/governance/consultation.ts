// The constitution's discussion guardrails for parameter changes: PARAM-04a
// (parameters critical to the operation of the blockchain) and PARAM-06a
// (critical to the governance system) ask that at least 90 days normally
// pass between publishing an off-chain proposal and submitting the on-chain
// action. Both are "x", the guardrails script does not check them, so the
// form only informs and never blocks. Leaf module, no I/O.
import { PARAM_DEFS, PARAM_KEYS, type ParamKey } from './paramDefs.js';

export const CONSULTATION_DAYS = 90;

const DAY_MS = 86_400_000;

/** The titles and guardrail ids of the picked parameters that carry the guardrail, in table order, or null. */
export function consultationFor(keys: readonly ParamKey[]): { titles: string[]; rules: string[] } | null {
  const flagged = PARAM_KEYS.filter((key) => keys.includes(key) && PARAM_DEFS[key].consultation !== null);
  if (flagged.length === 0) return null;
  return {
    titles: flagged.map((key) => PARAM_DEFS[key].title),
    rules: flagged.map((key) => PARAM_DEFS[key].consultation as string),
  };
}

/** "UTxO cost per byte", or "minimum pool cost and UTxO cost per byte" mid-sentence. */
function joinTitles(titles: string[]): string {
  // Sentence-case titles go lower case mid-sentence, a leading acronym (UTxO) keeps its case.
  const lower = titles.map((t) => (/^[A-Z]{2}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1)));
  return lower.length < 3 ? lower.join(' and ') : `${lower.slice(0, -1).join(', ')} and ${lower[lower.length - 1]}`;
}

function ageText(days: number): string {
  if (days === 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The note next to the Proposal Draft link: what the constitution asks for
 * the picked parameters and how long the linked draft has been public.
 * createdAt is the draft thread's creation time in milliseconds, null when
 * the linked draft is no longer in the open drafts list. Null when no picked
 * parameter carries the guardrail.
 */
export function draftConsultationNote(
  keys: readonly ParamKey[],
  linkedDraft: { createdAt: number | null } | null,
  now: number,
): string | null {
  const c = consultationFor(keys);
  if (!c) return null;
  const rules = c.rules.join(', ');
  const asks = `The constitution asks that at least ${CONSULTATION_DAYS} days normally pass between publishing an off-chain proposal to change ${joinTitles(c.titles)} and submitting it on chain (${rules}).`;
  if (!linkedDraft) return `${asks} No Proposal Draft is linked yet.`;
  if (linkedDraft.createdAt === null) return asks;
  const days = Math.max(0, Math.floor((now - linkedDraft.createdAt) / DAY_MS));
  if (days >= CONSULTATION_DAYS) {
    return `Your linked draft was published ${ageText(days)}, at least the ${CONSULTATION_DAYS} days the constitution asks for (${rules}).`;
  }
  return `Your linked draft was published ${ageText(days)}. ${asks}`;
}
