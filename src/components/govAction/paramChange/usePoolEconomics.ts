// The pool distribution for the impact charts, read from a same-origin route.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { economicsFromJson, type PoolEconomics, type PoolEconomicsJson } from '@/lib/governance/paramImpact.js';

export type PoolEconomicsState = { status: 'loading' } | { status: 'ready'; data: PoolEconomics } | { status: 'error' };

/**
 * Reads the pool data the first time `enabled` is true, and again on retry() after a failure.
 * Turning `enabled` off and on again reads nothing new, the data stays for the component's life.
 * A failure is not fatal: the charts say the figures are unavailable and offer the retry.
 */
export function usePoolEconomics(url: string, enabled: boolean): { economics: PoolEconomicsState; retry: () => void } {
  const [economics, setEconomics] = useState<PoolEconomicsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef(-1);
  useEffect(() => {
    if (!enabled || loaded.current === attempt) return;
    loaded.current = attempt;
    setEconomics({ status: 'loading' });
    fetchWithTimeout(`${window.location.origin}${url}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        setEconomics({ status: 'ready', data: economicsFromJson((await res.json()) as PoolEconomicsJson) });
      })
      .catch(() => setEconomics({ status: 'error' }));
  }, [url, enabled, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { economics, retry };
}
