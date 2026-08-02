/**
 * Bounded body reader: buffers an untrusted request/response body only up to a
 * byte limit, instead of arrayBuffer()-then-check. Content-Length is advisory
 * (absent on chunked transfer, and a sender can understate it), so callers keep
 * their early Content-Length rejection as a fast path and rely on this reader
 * as the enforced cap. On overflow the source stream is cancelled so the
 * remaining bytes are never pulled into Worker memory.
 */
export async function readBodyLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
