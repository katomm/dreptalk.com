// React hook: the event-type prefs state machine shared by the push and
// Telegram settings cards on /notifications. Owns the optimistic pref state,
// the master toggle (flips all event prefs in parallel) and the single
// pref toggle, both with snapshot-and-revert on failure and busy-serialization
// so an in-flight request can never be clobbered by an overlapping one.
import { useState } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { NOTIFICATION_EVENT_TYPES } from '@/lib/db/notificationChannels.js';
import type { NotificationEventType } from '@/lib/db/notificationChannels.js';

/**
 * Flips all event prefs for a channel in parallel. Used by the master
 * toggle. Resolves true only when every POST succeeded, so the caller can
 * revert its optimistic state on any failure.
 */
async function setAllPrefs(channel: 'webpush' | 'telegram', enabled: boolean): Promise<boolean> {
  const results = await Promise.all(
    NOTIFICATION_EVENT_TYPES.map((eventType) =>
      fetchWithTimeout('/api/notifications/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, eventType, enabled }),
      })
        .then((r) => r.ok)
        .catch(() => false),
    ),
  );
  return results.every(Boolean);
}

/**
 * useChannelPrefs
 *
 * React hook: owns the event-type prefs state for one notification channel
 * (webpush or telegram). Both settings cards use this identically; only the
 * channel kind and the server-rendered initial prefs differ between them.
 */
export function useChannelPrefs(
  channel: 'webpush' | 'telegram',
  initialPrefs: Record<NotificationEventType, boolean>,
): {
  prefState: Record<NotificationEventType, boolean>;
  prefError: string | null;
  prefsBusy: boolean;
  masterOn: boolean;
  toggleAll: () => Promise<void>;
  togglePref: (eventType: NotificationEventType, enabled: boolean) => Promise<void>;
} {
  const [prefState, setPrefState] = useState<Record<NotificationEventType, boolean>>(initialPrefs);
  const [prefError, setPrefError] = useState<string | null>(null);
  // True while a prefs request (master or single toggle) is in flight. Serializes
  // pref updates so the snapshot-and-revert below can never discard a change
  // from an overlapping request.
  const [prefsBusy, setPrefsBusy] = useState(false);

  const masterOn = Object.values(prefState).some(Boolean);

  async function toggleAll() {
    if (prefsBusy) return;
    const next = !masterOn;
    const prev = prefState;
    setPrefError(null);
    setPrefsBusy(true);
    setPrefState(
      Object.fromEntries(NOTIFICATION_EVENT_TYPES.map((t) => [t, next])) as Record<NotificationEventType, boolean>,
    );
    try {
      const ok = await setAllPrefs(channel, next);
      if (!ok) {
        setPrefState(prev);
        setPrefError('Could not save that setting. Please try again.');
      }
    } finally {
      setPrefsBusy(false);
    }
  }

  async function togglePref(eventType: NotificationEventType, enabled: boolean) {
    if (prefsBusy) return;
    setPrefError(null);
    const prev = prefState;
    setPrefsBusy(true);
    setPrefState((p) => ({ ...p, [eventType]: enabled }));
    try {
      const res = await fetchWithTimeout('/api/notifications/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, eventType, enabled }),
      });
      if (!res.ok) {
        setPrefState(prev);
        setPrefError('Could not save that setting. Please try again.');
      }
    } catch {
      setPrefState(prev);
      setPrefError('Could not save that setting. Please try again.');
    } finally {
      setPrefsBusy(false);
    }
  }

  return { prefState, prefError, prefsBusy, masterOn, toggleAll, togglePref };
}
