// Post-edit grace window. Within this window after posting, edits are silent
// (no revision archived, no "(edited)" marker). After it, every edit archives
// the prior version and stamps edited_at. Time-only: engagement does not end it.

export const EDIT_GRACE_MS = 15 * 60 * 1000;

/** True while an edit at `now` to a post created at `createdAt` is still silent. */
export function isWithinGrace(createdAt: number, now: number): boolean {
  return now - createdAt <= EDIT_GRACE_MS;
}

/**
 * The edit rule for a row its author owns, shared by the write path and the
 * pages. A row stamped with a grant follows exactly that grant
 * (stampedGrantActive, read from D1), own writer roles do not override it, so
 * a revoked mandate locks its rows. An unstamped row needs an own writer role.
 */
export function mayEditRow(stampedGrantId: string | null | undefined, ownWriter: boolean, stampedGrantActive: boolean): boolean {
  return stampedGrantId ? stampedGrantActive : ownWriter;
}
