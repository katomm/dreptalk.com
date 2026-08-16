import { describe, it, expect } from 'vitest';
import { buildServiceDescription } from './service.js';

describe('buildServiceDescription', () => {
  it('describes the URL templates and the deletion contract', () => {
    const doc = JSON.parse(buildServiceDescription('https://dreptalk.com', 'mainnet'));
    expect(doc.network).toBe('mainnet');
    expect(doc.context).toBe('https://dreptalk.com/cip100/context/v1.jsonld');
    expect(doc.urlTemplates.snapshot).toBe('https://dreptalk.com/cip100/{hash}.json');
    expect(doc.urlTemplates.thread).toBe('https://dreptalk.com/cip100/topic/{topicId}.json');
    expect(doc.hashAlgorithm).toBe('blake2b-256');
    expect(doc.documentTypes.snapshot).toBe('DiscussionPost');
    expect(doc.deletion).toContain('410');
    expect(doc.caching).toContain('immutable');
  });

  // Both claims are published to integrators, so they are pinned here: they
  // were false once and the guide had to be corrected alongside them.
  it('does not claim every post is published, and tells mirrors to act on a disappearance', () => {
    const doc = JSON.parse(buildServiceDescription('https://dreptalk.com', 'mainnet'));
    expect(doc.description).not.toMatch(/every/i);
    expect(doc.deletion).toMatch(/without a tombstone/);
    expect(doc.deletion).toMatch(/stop serving/);
    // A thread can vanish as a whole, and a mirror needs to be told what that
    // means for the posts it already holds.
    expect(doc.deletion).toMatch(/manifest itself answers 410/);
    // Only the snapshot is a CIP-100 document. The other two are ours.
    expect(doc.documentClasses.postVersions).toMatch(/not a CIP-100 document/);
  });

  it('follows the deployment origin, with the vocabulary as the one exception', () => {
    const doc = JSON.parse(buildServiceDescription('https://preprod.dreptalk.com', 'preprod'));
    expect(doc.site).toBe('https://preprod.dreptalk.com/');
    // The context is the shared vocabulary, not content of this deployment, so
    // it stays on the canonical domain. Everything else follows the network.
    expect(doc.context).toBe('https://dreptalk.com/cip100/context/v1.jsonld');
    const { context, ...rest } = doc;
    expect(JSON.stringify(rest)).not.toContain('//dreptalk.com');
  });
});
