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
    expect(doc.deletion).toContain('410');
    expect(doc.caching).toContain('immutable');
  });

  it('follows the deployment origin', () => {
    const doc = JSON.parse(buildServiceDescription('https://preprod.dreptalk.com', 'preprod'));
    expect(doc.site).toBe('https://preprod.dreptalk.com/');
    expect(JSON.stringify(doc)).not.toContain('//dreptalk.com');
  });
});
