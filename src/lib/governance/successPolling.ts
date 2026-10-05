// Success screen poll (decision 11 of the gov-action-submit-polish design):
// after submit, ask GET /api/gov-action/status every 30 s for up to 10
// minutes, until gov-sync has picked the action up. Split in two so the
// schedule itself is unit-testable with plain numbers: nextSuccessPollState
// is pure (no clock, no timer), startStatusPolling is the small orchestration
// layer that calls it, with fetchStatus and the timer both injected so a test
// never needs a real network or React.
export const STATUS_POLL_INTERVAL_MS = 30_000;
export const STATUS_POLL_WINDOW_MS = 10 * 60 * 1000;

export interface GovActionStatusResponse {
  synced: boolean;
  slug: string | null;
  draft: { slug: string; title: string } | null;
}

export type SuccessPollState =
  | { kind: 'pending' }
  | { kind: 'synced'; slug: string | null; draft: { slug: string; title: string } | null }
  | { kind: 'timed-out' };

export interface NextSuccessPollOutcome {
  state: SuccessPollState;
  /** Whether another poll should be scheduled after this one. */
  scheduleNext: boolean;
}

/**
 * Decides the next poll state from how long the poll has been running and
 * the latest response (null for a failed fetch, treated the same as "not
 * synced yet"). Synced wins even past the window: a slow last check that
 * still comes back synced is reported as synced, not timed out.
 */
export function nextSuccessPollState(
  elapsedMs: number,
  response: GovActionStatusResponse | null,
): NextSuccessPollOutcome {
  if (response?.synced) {
    return { state: { kind: 'synced', slug: response.slug, draft: response.draft }, scheduleNext: false };
  }
  if (elapsedMs >= STATUS_POLL_WINDOW_MS) {
    return { state: { kind: 'timed-out' }, scheduleNext: false };
  }
  return { state: { kind: 'pending' }, scheduleNext: true };
}

export interface StatusPollDeps {
  fetchStatus: () => Promise<GovActionStatusResponse | null>;
  onUpdate: (state: SuccessPollState) => void;
  /** Clock, overridable in tests. Defaults to Date.now. */
  now?: () => number;
  /** Timer functions, overridable in tests. Default to the real setTimeout/clearTimeout. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Drives the poll loop: fetch, run the result through nextSuccessPollState,
 * report the state, and schedule the next attempt unless the pure check says
 * to stop. Fires the first fetch right away. Returns a cancel function that
 * stops any pending timer, for the island's effect cleanup.
 *
 * The clock and the timer functions are looked up fresh on every call (never
 * cached in a local variable) so that switching to fake timers partway
 * through an already-running poll, as a test does after reaching the success
 * screen with real timers, still takes effect on the next tick.
 */
export function startStatusPolling(deps: StatusPollDeps): () => void {
  const startedAt = (deps.now ?? Date.now)();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    if (cancelled) return;
    let response: GovActionStatusResponse | null;
    try {
      response = await deps.fetchStatus();
    } catch {
      response = null;
    }
    if (cancelled) return;
    const elapsed = (deps.now ?? Date.now)() - startedAt;
    const { state, scheduleNext } = nextSuccessPollState(elapsed, response);
    deps.onUpdate(state);
    if (scheduleNext) {
      timer = (deps.setTimeoutFn ?? setTimeout)(() => void tick(), STATUS_POLL_INTERVAL_MS);
    }
  }

  void tick();

  return () => {
    cancelled = true;
    if (timer !== null) (deps.clearTimeoutFn ?? clearTimeout)(timer);
  };
}
