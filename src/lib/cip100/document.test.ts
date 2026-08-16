// The builder's output is a contract: the bytes are what third parties hash, so
// this test asserts the whole string, not individual fields. A diff here means
// every previously published hash would change, which is exactly the kind of
// drift the fixed vector exists to catch.
import { describe, it, expect } from 'vitest';
import { buildDiscussionPostDoc, type DiscussionPostDocInput } from './document.js';

const BASE: DiscussionPostDocInput = {
  origin: 'https://dreptalk.com',
  network: 'mainnet',
  postId: '6f1c9a8e-2b77-4c31-9a0e-1d2f3c4b5a60',
  topicId: '2c4d6e80-11aa-4f2b-8c93-77e0a1b2c3d4',
  topicSlug: 'should-we-fund-x-a1b2',
  version: 1,
  postedAt: 1_754_385_164_000,
  revisedAt: null,
  governanceActionId: null,
  parentPostId: null,
  parentDocHash: null,
  prevHash: null,
  postedBy: { handle: 'Tommy', profile: null, drepId: null, poolId: null },
  comment: 'A statement worth citing.',
};

describe('buildDiscussionPostDoc', () => {
  it('is deterministic', () => {
    expect(buildDiscussionPostDoc(BASE)).toEqual(buildDiscussionPostDoc(BASE));
  });

  it('produces a 64 hex hash of its own bytes', () => {
    const { body, hash } = buildDiscussionPostDoc(BASE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.endsWith('\n')).toBe(true);
    expect(JSON.parse(body).hashAlgorithm).toBe('blake2b-256');
  });

  it('emits empty authors and never a witness', () => {
    const doc = JSON.parse(buildDiscussionPostDoc(BASE).body);
    expect(doc.authors).toEqual([]);
  });

  // A consumer filtering governance metadata by document type reads the top
  // level. Typing the body instead would hide the post from it.
  it('types the document, not the body', () => {
    const doc = JSON.parse(buildDiscussionPostDoc(BASE).body);
    expect(doc['@type']).toBe('DiscussionPost');
    expect('@type' in doc.body).toBe(false);
  });

  it('omits optional fields instead of emitting null', () => {
    const doc = JSON.parse(buildDiscussionPostDoc(BASE).body);
    expect('revisedAt' in doc.body).toBe(false);
    expect('governanceActionId' in doc.body).toBe(false);
    expect('inReplyTo' in doc.body).toBe(false);
    expect('revisionOf' in doc.body).toBe(false);
    expect('profile' in doc.body.postedBy).toBe(false);
    expect('drepId' in doc.body.postedBy).toBe(false);
  });

  it('carries the reply id even when the parent snapshot is unknown', () => {
    const doc = JSON.parse(
      buildDiscussionPostDoc({ ...BASE, parentPostId: '0a1b2c3d', parentDocHash: null }).body,
    );
    expect(doc.body.inReplyToPostId).toBe('0a1b2c3d');
    expect('inReplyTo' in doc.body).toBe(false);
  });

  it('links the previous version on an edit', () => {
    const doc = JSON.parse(
      buildDiscussionPostDoc({ ...BASE, version: 2, revisedAt: 1_754_471_564_000, prevHash: 'a'.repeat(64) }).body,
    );
    expect(doc.body.version).toBe(2);
    expect(doc.body.revisedAt).toBe('2025-08-06T09:12:44Z');
    expect(doc.body.revisionOf).toBe(`https://dreptalk.com/cip100/${'a'.repeat(64)}.json`);
    expect(doc.body.references).toContainEqual({
      '@type': 'Other', label: 'Previous version', uri: `https://dreptalk.com/cip100/${'a'.repeat(64)}.json`,
    });
  });

  it('uses the deployment origin for every URL except the shared vocabulary', () => {
    const { body } = buildDiscussionPostDoc({ ...BASE, origin: 'https://preprod.dreptalk.com', network: 'preprod' });
    const doc = JSON.parse(body);
    // The vocabulary has one global identity and must keep resolving even if
    // preprod is retired, so it is the canonical URL on every network.
    expect(doc['@context'][1]).toBe('https://dreptalk.com/cip100/context/v1.jsonld');
    expect(JSON.stringify(doc.body)).not.toContain('https://dreptalk.com');
    expect(doc.body.network).toBe('preprod');
  });

  // The golden file. Vitest writes __snapshots__/discussion-post-v1.json on the
  // first run, and it is committed. From then on any byte that moves fails this
  // test, which is the whole point: a format change silently rewrites the hash
  // of every document ever published. Update the file only together with a
  // deliberate format change, never to make a test pass.
  it('matches the fixed vector byte for byte', async () => {
    await expect(buildDiscussionPostDoc(BASE).body).toMatchFileSnapshot(
      './__snapshots__/discussion-post-v1.json',
    );
  });
});
