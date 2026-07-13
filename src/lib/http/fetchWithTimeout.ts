// fetch with an abort-based timeout, so a hung backend cannot leave a React
// island stuck in a permanent loading/submitting state. On timeout the returned
// promise rejects with a clear Error, which the caller's existing catch routes
// into its error/retry UI. A caller-supplied `signal` is still honored (its abort
// wins and rethrows as a normal AbortError, distinct from the timeout).

const DEFAULT_TIMEOUT_MS = 20_000;

export interface FetchWithTimeoutInit extends RequestInit {
  /** Milliseconds before the request is aborted. Defaults to 20s. */
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: FetchWithTimeoutInit = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...rest, signal: ctrl.signal });
  } catch (err) {
    // The timeout fired (not a caller-initiated abort): surface a clear message.
    if (timedOut && !signal?.aborted) {
      throw new Error('The request timed out. Please check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
