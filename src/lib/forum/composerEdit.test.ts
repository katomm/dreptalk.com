import { describe, it, expect, vi } from 'vitest';
import { submitEdit } from './composer.js';

describe('submitEdit', () => {
  it('POSTs the body to the edit endpoint and resolves ok on 200', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, edited: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await submitEdit({ postId: 'p1', bodyMd: 'new body', fetchImpl });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/posts/p1/edit',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('resolves the server error message on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'topic_locked' }), { status: 403 }),
    ) as unknown as typeof fetch;
    const res = await submitEdit({ postId: 'p1', bodyMd: 'x', fetchImpl });
    expect(res).toEqual({ ok: false, error: 'topic_locked' });
  });
});
