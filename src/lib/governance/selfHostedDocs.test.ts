// URL mapping for the self-hosted document short circuit. Pure logic, node env.
import { describe, it, expect } from 'vitest';
import { selfHostedRef } from './selfHostedDocs.js';

const HASH = 'a'.repeat(64);

describe('selfHostedRef', () => {
  it('maps a hosted DRep metadata URL on the apex host', () => {
    expect(selfHostedRef(`https://dreptalk.com/drep/${HASH}.json`)).toEqual({
      kind: 'drep-metadata',
      hash: HASH,
    });
  });

  it('maps subdomains (same-zone loop prevention hits every host on the zone)', () => {
    expect(selfHostedRef(`https://preprod.dreptalk.com/drep/${HASH}.json`)).toEqual({
      kind: 'drep-metadata',
      hash: HASH,
    });
    expect(selfHostedRef(`https://www.dreptalk.com/vote-rationale/${HASH}.json`)).toEqual({
      kind: 'vote-rationale',
      hash: HASH,
    });
  });

  it('maps plain-http URLs (broken registrations exist on chain)', () => {
    expect(selfHostedRef(`http://dreptalk.com/drep/${HASH}.json`)).toEqual({
      kind: 'drep-metadata',
      hash: HASH,
    });
  });

  it('maps a hosted vote rationale URL', () => {
    expect(selfHostedRef(`https://dreptalk.com/vote-rationale/${HASH}.json`)).toEqual({
      kind: 'vote-rationale',
      hash: HASH,
    });
  });

  it('maps a self-hosted avatar URL (no .json suffix)', () => {
    expect(selfHostedRef(`https://dreptalk.com/api/avatar/${HASH}`)).toEqual({
      kind: 'avatar',
      hash: HASH,
    });
  });

  it('returns null for foreign hosts, including lookalikes', () => {
    expect(selfHostedRef(`https://example.com/drep/${HASH}.json`)).toBeNull();
    expect(selfHostedRef(`https://dreptalk.com.evil.example/drep/${HASH}.json`)).toBeNull();
    expect(selfHostedRef(`https://evildreptalk.com/drep/${HASH}.json`)).toBeNull();
  });

  it('returns null for non-http schemes and malformed URLs', () => {
    expect(selfHostedRef(`ipfs://dreptalk.com/drep/${HASH}.json`)).toBeNull();
    expect(selfHostedRef('not a url')).toBeNull();
  });

  it('returns null for self-zone paths that are not hosted documents', () => {
    expect(selfHostedRef('https://dreptalk.com/')).toBeNull();
    expect(selfHostedRef('https://dreptalk.com/logo.png')).toBeNull();
    expect(selfHostedRef(`https://dreptalk.com/drep/${HASH}`)).toBeNull(); // no .json
    expect(selfHostedRef(`https://dreptalk.com/drep/${'A'.repeat(64)}.json`)).toBeNull(); // uppercase
    expect(selfHostedRef(`https://dreptalk.com/drep/${'a'.repeat(63)}.json`)).toBeNull(); // short
  });
});
