/// <reference types="@cloudflare/workers-types" />
// Workers-runtime test for POST /api/drep/image: the unauthenticated upload
// must stop reading an oversize body at the byte cap instead of buffering it
// whole; content-length is absent on a chunked sender, so only the bounded
// reader protects Worker memory here.
import { describe, it, expect } from 'vitest';
import { POST } from '../image';

describe('drep image upload body cap', () => {
  it('cuts off a chunked oversize body at the cap instead of buffering 10+ MB', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0xff);
    const capChunks = Math.ceil((10 * 1024 * 1024) / chunk.byteLength);
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const request = new Request('https://dreptalk.com/api/drep/image', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: endless,
    });
    const res = await POST({ request, locals: {} as App.Locals } as Parameters<typeof POST>[0]);

    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    // Reading stopped just past the cap; the old buffer-then-check shape would
    // have drained far more than capChunks pulls before rejecting.
    expect(pulls).toBeLessThanOrEqual(capChunks + 2);
  });
});
