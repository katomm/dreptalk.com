import { describe, it, expect } from 'vitest';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { extractVoteRationaleComment, fetchVoteRationale } from './voteRationaleAnchor.js';

describe('extractVoteRationaleComment', () => {
  it('reads CIP-100 body.comment', () => {
    expect(extractVoteRationaleComment({ body: { comment: 'I support **this**.' } })).toBe('I support **this**.');
  });
  it('composes CIP-136 prose when there is no comment', () => {
    const doc = {
      body: {
        summary: 'We vote YES.',
        rationaleStatement: 'The proposal was rescoped and unbundled.',
        conclusion: 'We will track follow-through.',
      },
    };
    const text = extractVoteRationaleComment(doc);
    expect(text).toContain('We vote YES.');
    expect(text).toContain('rescoped and unbundled');
    expect(text).toContain('track follow-through');
  });
  it('prefers comment over CIP-136 fields when both exist', () => {
    expect(extractVoteRationaleComment({ body: { comment: 'short', summary: 'long summary' } })).toBe('short');
  });
  it('reads a bare body.rationale field', () => {
    expect(extractVoteRationaleComment({ body: { rationale: 'I vote NO because of the NCL.' } })).toBe(
      'I vote NO because of the NCL.',
    );
  });
  it('composes summary with body.rationale when both exist', () => {
    const text = extractVoteRationaleComment({ body: { summary: 'We vote YES.', rationale: 'Full reasoning here.' } });
    expect(text).toContain('We vote YES.');
    expect(text).toContain('Full reasoning here.');
  });
  it('prefers rationaleStatement over rationale when both exist', () => {
    const text = extractVoteRationaleComment({ body: { rationaleStatement: 'canonical', rationale: 'duplicate' } });
    expect(text).toBe('canonical');
  });
  it('prefers comment over rationale when both exist', () => {
    expect(extractVoteRationaleComment({ body: { comment: 'short', rationale: 'long rationale' } })).toBe('short');
  });
  it('returns null when the document carries no prose', () => {
    expect(extractVoteRationaleComment({ body: { other: 'x' } })).toBeNull();
    expect(extractVoteRationaleComment({ body: { internalVote: { constitutional: 4 } } })).toBeNull();
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

  it('reports empty (not failed) on a verified doc with no prose', async () => {
    const noProse = JSON.stringify({ body: { internalVote: { constitutional: 4 } } });
    const hash = bytesToHex(blake2b256(new TextEncoder().encode(noProse)));
    const fetchNoProse = async () =>
      new Response(noProse, { status: 200, headers: { 'content-type': 'application/json' } });
    const r = await fetchVoteRationale('https://example.org/r.json', hash, { fetchImpl: fetchNoProse as typeof fetch });
    expect(r.status).toBe('empty');
  });
});
