import { describe, it, expect } from 'vitest';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { extractVoteRationaleComment, fetchVoteRationale } from './voteRationaleAnchor.js';

describe('extractVoteRationaleComment', () => {
  it('reads CIP-100 body.comment', () => {
    expect(extractVoteRationaleComment({ body: { comment: 'I support **this**.' } })).toBe('I support **this**.');
  });
  it('returns null when there is no comment', () => {
    expect(extractVoteRationaleComment({ body: { other: 'x' } })).toBeNull();
    expect(extractVoteRationaleComment('nope')).toBeNull();
  });
});

describe('fetchVoteRationale', () => {
  const body = JSON.stringify({ body: { comment: 'Hello rationale' } });
  const okFetch = async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

  it('renders sanitized HTML on a verified anchor', async () => {
    const hash = bytesToHex(blake2b256(new TextEncoder().encode(body)));
    const r = await fetchVoteRationale('https://example.org/r.json', hash, { fetchImpl: okFetch as typeof fetch });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.bodyHtml).toContain('Hello rationale');
  });

  it('fails closed on a hash mismatch', async () => {
    const r = await fetchVoteRationale('https://example.org/r.json', '00'.repeat(32), { fetchImpl: okFetch as typeof fetch });
    expect(r.status).toBe('failed');
  });
});
