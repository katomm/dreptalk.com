import { describe, it, expect, vi } from 'vitest';
import { verifyHostedAnchor } from './anchorSelfVerify.js';
import { blake2b256 } from '@/lib/crypto/blake.js';
import { bytesToHex } from '@/lib/crypto/hex.js';

const bytesOf = (s: string) => new TextEncoder().encode(s);
const hashOf = (s: string) => bytesToHex(blake2b256(bytesOf(s)));
const serve = (s: string, status = 200) => async () => new Response(status === 200 ? bytesOf(s) : 'x', { status });

describe('verifyHostedAnchor', () => {
  it('returns ok when the served bytes hash to the expected hash', async () => {
    const body = '{"body":{"comment":"hi"}}';
    const v = await verifyHostedAnchor('https://x/a.json', hashOf(body), { fetchImpl: serve(body) as typeof fetch });
    expect(v).toBe('ok');
  });

  it('returns mismatch when the served bytes hash to something else', async () => {
    const v = await verifyHostedAnchor('https://x/a.json', hashOf('{"body":{"comment":"hi"}}'), {
      fetchImpl: serve('{"body":{"comment":"TAMPERED"}}') as typeof fetch,
    });
    expect(v).toBe('mismatch');
  });

  it('does not retry on a mismatch (content is address-stable)', async () => {
    const impl = vi.fn(serve('{"body":{"comment":"other"}}') as typeof fetch);
    await verifyHostedAnchor('https://x/a.json', hashOf('{"a":1}'), { fetchImpl: impl, attempts: 5, backoffMs: 0 });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('retries then returns unavailable on persistent non-2xx', async () => {
    const impl = vi.fn(serve('', 503) as typeof fetch);
    const v = await verifyHostedAnchor('https://x/a.json', hashOf('{}'), { fetchImpl: impl, attempts: 3, backoffMs: 0 });
    expect(v).toBe('unavailable');
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('returns unavailable when the fetch throws', async () => {
    const impl = vi.fn(async () => {
      throw new Error('network');
    });
    const v = await verifyHostedAnchor('https://x/a.json', hashOf('{}'), { fetchImpl: impl as typeof fetch, attempts: 2, backoffMs: 0 });
    expect(v).toBe('unavailable');
    expect(impl).toHaveBeenCalledTimes(2);
  });
});
