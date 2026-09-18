import { PROPOSAL_DRAFTS_CATEGORY_SLUG } from '../../../config/categories.js';

// Starting skeleton for a new Proposal Drafts thread. Plain Markdown, nothing is
// required or validated. The HTML comments are hints for the writer and are
// stripped by the sanitizer, so a skeleton posted unchanged renders as bare headings.
export const DRAFT_TEMPLATE = `## Summary

## Action type
<!-- Info, Treasury withdrawal, Parameter change, Hard fork, Constitution, Committee, No confidence -->

## Requested amount
<!-- Treasury withdrawals only, in ada -->

## Motivation

## Planned submission
<!-- Epoch or date you intend to submit on-chain -->
`;

/** The composer's starting body: the skeleton for a new draft thread, empty otherwise. */
export function initialDraftBody(mode: 'topic' | 'post', categorySlug?: string): string {
  return mode === 'topic' && categorySlug === PROPOSAL_DRAFTS_CATEGORY_SLUG ? DRAFT_TEMPLATE : '';
}
