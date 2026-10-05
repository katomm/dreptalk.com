// Pure scheduling logic for the success screen's "is this action on
// DRepTalk yet" poll (decision 11 of the gov-action-submit-polish design):
// every 30 s for up to 10 minutes, stop as soon as the action is synced.
// nextSuccessPollState takes plain numbers, so the schedule is asserted here
// without a single timer. startStatusPolling's own orchestration (the part
// that actually calls setTimeout) is exercised with vitest's fake timers
// further down, still with no React and no DOM.
import { describe, it, expect, vi } from 'vitest';
import {
  nextSuccessPollState,
  startStatusPolling,
  STATUS_POLL_INTERVAL_MS,
  STATUS_POLL_WINDOW_MS,
  type GovActionStatusResponse,
} from './successPolling.js';

describe('nextSuccessPollState', () => {
  it('keeps polling while not synced and the window has not elapsed', () => {
    const out = nextSuccessPollState(0, { synced: false, slug: null, draft: null });
    expect(out).toEqual({ state: { kind: 'pending' }, scheduleNext: true });
  });

  it('stays pending right up to the last moment inside the window', () => {
    const out = nextSuccessPollState(STATUS_POLL_WINDOW_MS - 1, { synced: false, slug: null, draft: null });
    expect(out.scheduleNext).toBe(true);
    expect(out.state.kind).toBe('pending');
  });

  it('times out once the window has fully elapsed', () => {
    const out = nextSuccessPollState(STATUS_POLL_WINDOW_MS, { synced: false, slug: null, draft: null });
    expect(out).toEqual({ state: { kind: 'timed-out' }, scheduleNext: false });
  });

  it('times out on a null response (a failed fetch) past the window', () => {
    const out = nextSuccessPollState(STATUS_POLL_WINDOW_MS, null);
    expect(out).toEqual({ state: { kind: 'timed-out' }, scheduleNext: false });
  });

  it('keeps polling on a null response (a failed fetch) inside the window', () => {
    const out = nextSuccessPollState(1000, null);
    expect(out).toEqual({ state: { kind: 'pending' }, scheduleNext: true });
  });

  it('stops and reports synced with no draft', () => {
    const response: GovActionStatusResponse = { synced: true, slug: 'my-action-ab12', draft: null };
    const out = nextSuccessPollState(60_000, response);
    expect(out).toEqual({
      state: { kind: 'synced', slug: 'my-action-ab12', draft: null },
      scheduleNext: false,
    });
  });

  it('stops and reports synced with the linked draft', () => {
    const response: GovActionStatusResponse = {
      synced: true,
      slug: 'my-action-ab12',
      draft: { slug: 'fund-tooling-c3d4', title: 'Fund tooling' },
    };
    const out = nextSuccessPollState(60_000, response);
    expect(out).toEqual({
      state: { kind: 'synced', slug: 'my-action-ab12', draft: { slug: 'fund-tooling-c3d4', title: 'Fund tooling' } },
      scheduleNext: false,
    });
  });

  it('synced wins even once the window has elapsed', () => {
    const response: GovActionStatusResponse = { synced: true, slug: 'my-action-ab12', draft: null };
    const out = nextSuccessPollState(STATUS_POLL_WINDOW_MS + 60_000, response);
    expect(out.state.kind).toBe('synced');
  });
});

describe('startStatusPolling', () => {
  it('polls once immediately, reports pending, and schedules the next attempt 30 s out', async () => {
    vi.useFakeTimers();
    try {
      const fetchStatus = vi.fn(async (): Promise<GovActionStatusResponse> => ({ synced: false, slug: null, draft: null }));
      const onUpdate = vi.fn();
      startStatusPolling({ fetchStatus, onUpdate });

      await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1));
      expect(onUpdate).toHaveBeenLastCalledWith({ kind: 'pending' });

      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);
      expect(fetchStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops scheduling once synced', async () => {
    vi.useFakeTimers();
    try {
      const fetchStatus = vi.fn(async (): Promise<GovActionStatusResponse> => ({
        synced: true,
        slug: 'my-action-ab12',
        draft: null,
      }));
      const onUpdate = vi.fn();
      startStatusPolling({ fetchStatus, onUpdate });

      await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1));
      expect(onUpdate).toHaveBeenLastCalledWith({ kind: 'synced', slug: 'my-action-ab12', draft: null });

      await vi.advanceTimersByTimeAsync(STATUS_POLL_WINDOW_MS * 2);
      expect(fetchStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops scheduling once the window elapses, reporting timed-out', async () => {
    vi.useFakeTimers();
    try {
      const fetchStatus = vi.fn(async (): Promise<GovActionStatusResponse> => ({ synced: false, slug: null, draft: null }));
      const onUpdate = vi.fn();
      startStatusPolling({ fetchStatus, onUpdate });

      await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(STATUS_POLL_WINDOW_MS + STATUS_POLL_INTERVAL_MS);

      expect(onUpdate).toHaveBeenLastCalledWith({ kind: 'timed-out' });
      const callsAfterTimeout = fetchStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS * 3);
      expect(fetchStatus).toHaveBeenCalledTimes(callsAfterTimeout);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel stops any further poll', async () => {
    vi.useFakeTimers();
    try {
      const fetchStatus = vi.fn(async (): Promise<GovActionStatusResponse> => ({ synced: false, slug: null, draft: null }));
      const onUpdate = vi.fn();
      const cancel = startStatusPolling({ fetchStatus, onUpdate });

      await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1));
      cancel();
      await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS * 5);
      expect(fetchStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
