// Single source of truth for the session sliding-renewal cadence, shared by the
// KV renewal in session.ts and the D1 last_seen throttle guard in db/users.ts so
// the two can never drift.

export const SLIDING_WINDOW_SEC = 21_600; // 6 hours
export const SESSION_ACTIVITY_THROTTLE_MS = SLIDING_WINDOW_SEC * 1000;
