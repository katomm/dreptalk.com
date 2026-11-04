/**
 * Settles every promise in a keyed object at once and returns the values under
 * the same keys. Lets a page start many independent reads together and still
 * read the results by name instead of by tuple position.
 */
export async function awaitAll<T extends Record<string, unknown>>(
  promises: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(promises);
  const values = await Promise.all(keys.map((k) => promises[k]));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as { [K in keyof T]: Awaited<T[K]> };
}
