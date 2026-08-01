import { describe, it, expect } from 'vitest';
import { readBodyLimited } from './bodyLimit.js';

/** A stream of `chunks` that records whether the consumer cancelled it. */
function trackedStream(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe('readBodyLimited', () => {
  it('returns the exact bytes of a body under the limit', async () => {
    const { stream } = trackedStream([bytes(3, 1), bytes(2, 2)]);
    const read = await readBodyLimited(stream, 10);
    expect(read.ok).toBe(true);
    if (read.ok) expect([...read.bytes]).toEqual([1, 1, 1, 2, 2]);
  });

  it('accepts a body exactly at the limit', async () => {
    const { stream } = trackedStream([bytes(10)]);
    const read = await readBodyLimited(stream, 10);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.bytes.byteLength).toBe(10);
  });

  it('treats a null body as empty', async () => {
    const read = await readBodyLimited(null, 10);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.bytes.byteLength).toBe(0);
  });

  it('stops reading and cancels the source once the limit is crossed', async () => {
    // 3 chunks of 8 bytes against a limit of 10: the reader must give up on the
    // second chunk instead of buffering the rest.
    const { stream, cancelled } = trackedStream([bytes(8), bytes(8), bytes(8)]);
    const read = await readBodyLimited(stream, 10);
    expect(read.ok).toBe(false);
    expect(cancelled()).toBe(true);
  });

  it('rejects a single chunk larger than the limit', async () => {
    const { stream } = trackedStream([bytes(11)]);
    const read = await readBodyLimited(stream, 10);
    expect(read.ok).toBe(false);
  });
});
