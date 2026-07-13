import { describe, it, expect, vi } from 'vitest';
import { fetchWithTimeout } from './fetchWithTimeout.js';

describe('fetchWithTimeout', () => {
  it('rejects with a clear timeout error when the response never arrives', async () => {
    const orig = globalThis.fetch;
    // A fetch that only settles when its signal aborts (i.e. a hung backend).
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    try {
      await expect(fetchWithTimeout('/x', { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('returns the response when it arrives before the timeout', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    try {
      const res = await fetchWithTimeout('/x', { timeoutMs: 1000 });
      expect(await res.text()).toBe('ok');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('rethrows a caller abort as-is (not as a timeout)', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    const ac = new AbortController();
    try {
      const p = fetchWithTimeout('/x', { timeoutMs: 10_000, signal: ac.signal });
      ac.abort();
      await expect(p).rejects.toThrow(/aborted/i); // the caller's abort, not the timeout message
    } finally {
      globalThis.fetch = orig;
    }
  });
});
