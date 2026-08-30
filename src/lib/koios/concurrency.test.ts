import { describe, expect, it } from 'vitest';
import { mapLimit } from './concurrency';

// Deferred promise helper: lets the test control resolution order.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('mapLimit', () => {
  it('returns results in input order even when tasks finish out of order', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const out = mapLimit([0, 1, 2], 3, async (i) => {
      await gates[i].promise;
      return `r${i}`;
    });
    gates[2].resolve();
    gates[0].resolve();
    gates[1].resolve();
    expect(await out).toEqual(['r0', 'r1', 'r2']);
  });

  it('never runs more than the limit concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async (i) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return i * 2;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(result).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it('short-circuits on empty input', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  it('propagates the first rejection', async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error('boom');
        return i;
      }),
    ).rejects.toThrow('boom');
  });
});
