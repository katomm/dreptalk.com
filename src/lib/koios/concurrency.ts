// Bounded-concurrency mapping for Koios batch reads. The origins analysis
// chain was measured fully sequential at ~65s for the largest mainnet DRep
// (79 calls, no 429s), so a small window of parallel requests cuts wall time
// several-fold without touching chunk sizes or retry semantics: each task
// still runs one chunk with its own retry/halving behavior.

// In-flight request cap per batched stage. Measured live on 2026-08-30: a
// window of 6 tripped Koios's unauthenticated burst limit (429) on a long
// back-to-back run, 4 stayed clean while still cutting the largest DRep's
// wall time several-fold versus the sequential chain.
export const KOIOS_BATCH_CONCURRENCY = 4;

/**
 * Maps items with at most `limit` tasks in flight, preserving input order in
 * the results. Rejects on the first task error (in-flight tasks settle
 * unobserved), matching the fail-the-whole-batch contract of the chunked
 * Koios readers.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
