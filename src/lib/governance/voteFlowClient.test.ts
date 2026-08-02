// Unit tests for the shared vote-flow client helpers, above all the anchor
// self-verify inside hostVoteRationale: every flow that commits an anchor hash
// on-chain (VotePanel, MultiVoteBar, MultisigVotePanel) goes through this one
// function, so its verify semantics are the regression net for all of them.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { hostVoteRationale, PreSignError } from './voteFlowClient.js';
import { blake2b256 } from '@/lib/crypto/blake.js';
import { bytesToHex } from '@/lib/crypto/hex.js';

const DOC = new TextEncoder().encode('{"body":{"comment":"why I voted"}}');
const DOC_HASH = bytesToHex(blake2b256(DOC));
const ANCHOR = { url: 'https://host.example/r.json', hash: DOC_HASH };
const ARGS = { gaId: 'gtx1#0', drepId: 'drep1xy', rationale: 'why I voted' };

/** Serves the hosting POST with `anchor` and the anchor URL with `served` bytes (404 when null). */
function stubFetch(anchor: { url: string; hash: string }, served: Uint8Array | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/vote/rationale')) {
        return new Response(JSON.stringify(anchor), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (served == null) return new Response('not yet', { status: 404 });
      // .slice() re-buffers so the body is a plain ArrayBuffer (BodyInit).
      return new Response(served.slice().buffer, { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hostVoteRationale', () => {
  it('returns the anchor once the served bytes re-hash to the committed hash', async () => {
    stubFetch(ANCHOR, DOC);
    await expect(hostVoteRationale(ARGS)).resolves.toEqual(ANCHOR);
  });

  it('aborts with a PreSignError when the served bytes do not match the hash', async () => {
    stubFetch(ANCHOR, new TextEncoder().encode('tampered content'));
    const attempt = hostVoteRationale(ARGS);
    await expect(attempt).rejects.toBeInstanceOf(PreSignError);
    await expect(hostVoteRationale(ARGS)).rejects.toThrow(/did not match its hash/);
  });

  it('does not block the vote on a transient verify unavailability', async () => {
    // The anchor URL 404s (read-after-write propagation): verdict 'unavailable',
    // which must not abort, since the host already hashed the stored bytes.
    stubFetch(ANCHOR, null);
    await expect(hostVoteRationale(ARGS)).resolves.toEqual(ANCHOR);
  }, 10_000);

  it('maps a hosting failure to a PreSignError carrying the server detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'rationale too long' }), { status: 400 })),
    );
    await expect(hostVoteRationale(ARGS)).rejects.toThrow(/Could not host rationale: rationale too long/);
  });
});
