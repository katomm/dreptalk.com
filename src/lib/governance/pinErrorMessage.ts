// The sentence the submit form shows when one of the two routes that pin to
// IPFS (the proposal metadata, the constitution document) refuses for a
// reason the user cannot fix by editing the form. Every sentence speaks about
// the transaction and the deposit only, because by then an author signature
// may already exist and, for a new constitution, the constitution document may
// already be published.

const NOTHING_SPENT = 'No transaction was signed and no deposit was spent.';

/**
 * `error` is the route's `{ error }` field, absent when the body was not JSON.
 * Null when the caller's own message for that route fits.
 */
export function pinRefusalMessage(status: number, error: string | undefined): string | null {
  if (error === 'pin_budget_global') {
    return `Publishing is paused for today. ${NOTHING_SPENT} Try again after 00:00 UTC.`;
  }
  if (error === 'pin_budget_ip') {
    return `Publishing from this network connection is paused for today. ${NOTHING_SPENT} Try again after 00:00 UTC.`;
  }
  // Every 5xx from these routes happens before any transaction exists: a
  // missing binding, the hosting provider refusing the upload, or a failed
  // write. The routes do not say which, so neither does the sentence.
  if (status >= 500) return `Publishing failed on our side. ${NOTHING_SPENT} Please try again later.`;
  return null;
}
