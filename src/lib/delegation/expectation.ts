// The window in which a recorded expectation still describes reality. Longer
// than the worst case refresh cadence on purpose: a failed refresh stamps
// refresh_attempted_at and pushes the next cron attempt to about 48 hours, so a
// shorter window would expire before the confirming pass and the person would
// be notified about their own delegation after all.
export const EXPECTED_TTL_SEC = 60 * 3600;

/** Whether an expectation stamp is still inside the window at `now` (unix seconds). */
export function expectationLive(expectedAt: number | null, now: number): boolean {
  return expectedAt != null && expectedAt >= now - EXPECTED_TTL_SEC;
}
