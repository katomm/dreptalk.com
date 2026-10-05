// "Link a Proposal Draft" control on the submit form (/ga/new), placed
// directly above the references list. Picking a draft calls onLink, which the
// island turns into the linkDraft reducer action, and clearing the selection
// calls onUnlink. Presentational and dumb like ReadinessList: the open drafts
// list, the tracked slug and the derivation of what to show for a closed
// draft are all the island's job (see govActionFormState.ts's
// linkedDraftReference), this only renders the select and the help text.
import type { ChangeEvent, CSSProperties } from 'react';
import { labelStyle, mutedStyle, inputStyle } from '@/components/drepFormStyles.js';
import { DRAFT_SLUG_RE } from '@/lib/governance/govActionFormState.js';

export interface DraftLinkControlOption {
  slug: string;
  title: string;
  own: boolean;
}

export interface DraftLinkControlProps {
  /** The open Proposal Drafts threads, own first then newest (see listOpenProposalDrafts). */
  openDrafts: readonly DraftLinkControlOption[];
  /** The tracked slug, or null when nothing is linked. */
  linkedDraftSlug: string | null;
  /**
   * The tracked reference's label, used only when the tracked slug has fallen
   * out of openDrafts (closed, linked elsewhere, or deleted), so the select
   * still shows a title instead of the bare slug. Ignored otherwise.
   */
  linkedDraftLabel: string;
  onLink: (draft: { slug: string; title: string }) => void;
  onUnlink: () => void;
  /** The reducer's draftLinkError (the append-at-cap refusal), shown next to the control. */
  error?: string | null;
  disabled?: boolean;
}

const errorStyle: CSSProperties = { ...mutedStyle, color: 'var(--danger, #b3261e)', margin: '0.25rem 0 0' };
const helpStyle: CSSProperties = { ...mutedStyle, margin: '0.25rem 0 0', display: 'block' };

export default function DraftLinkControl({
  openDrafts,
  linkedDraftSlug,
  linkedDraftLabel,
  onLink,
  onUnlink,
  error,
  disabled,
}: DraftLinkControlProps) {
  // A slug from any caller (not only the reducer's own validated restore
  // path) is treated as untrusted here too: one that fails the slug shape is
  // rendered as if nothing were tracked, rather than trusted as a select
  // option's value.
  const safeLinkedDraftSlug = linkedDraftSlug !== null && DRAFT_SLUG_RE.test(linkedDraftSlug) ? linkedDraftSlug : null;
  const trackedInList = safeLinkedDraftSlug !== null && openDrafts.some((d) => d.slug === safeLinkedDraftSlug);
  const trackedMissing = safeLinkedDraftSlug !== null && !trackedInList;

  function handleChange(e: ChangeEvent<HTMLSelectElement>) {
    const slug = e.target.value;
    if (!slug) {
      onUnlink();
      return;
    }
    const draft = openDrafts.find((d) => d.slug === slug);
    onLink({ slug, title: draft?.title ?? (linkedDraftLabel || slug) });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <label htmlFor="ga-draft-link" style={labelStyle}>
        Link a Proposal Draft
      </label>
      {openDrafts.length === 0 && !trackedMissing ? (
        <p style={helpStyle}>
          No open Proposal Drafts. <a href="/c/proposal-drafts/">Browse the Proposal Drafts category</a>.
        </p>
      ) : (
        <>
          <select
            id="ga-draft-link"
            value={safeLinkedDraftSlug ?? ''}
            onChange={handleChange}
            disabled={disabled}
            style={inputStyle}
          >
            <option value="">No draft linked</option>
            {openDrafts.map((d) => (
              <option key={d.slug} value={d.slug}>
                {d.title}
                {d.own ? ' (yours)' : ''}
              </option>
            ))}
            {trackedMissing && safeLinkedDraftSlug !== null && (
              <option value={safeLinkedDraftSlug}>{linkedDraftLabel || safeLinkedDraftSlug}</option>
            )}
          </select>
          <span style={helpStyle}>
            Linking a Proposal Draft adds it as a reference, and DRepTalk links the on-chain action back to the
            thread automatically.
          </span>
        </>
      )}
      {trackedMissing && <p style={errorStyle}>This draft is no longer open</p>}
      {error && <p style={errorStyle}>{error}</p>}
    </div>
  );
}
