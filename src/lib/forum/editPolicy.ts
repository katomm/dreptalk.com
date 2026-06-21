// Post-edit grace window. Within this window after posting, edits are silent
// (no revision archived, no "(edited)" marker). After it, every edit archives
// the prior version and stamps edited_at. Time-only: engagement does not end it.

export const EDIT_GRACE_MS = 15 * 60 * 1000;

/** True while an edit at `now` to a post created at `createdAt` is still silent. */
export function isWithinGrace(createdAt: number, now: number): boolean {
  return now - createdAt <= EDIT_GRACE_MS;
}
