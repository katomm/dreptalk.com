import { describe, it, expect } from 'vitest';
import { draftSlugsFromReferences } from './draftLink';
import { resolveNetwork } from '../config/network';

const MAIN = 'https://dreptalk.com';
const ref = (uri: string) => ({ label: '', uri });

describe('draftSlugsFromReferences', () => {
  it('returns nothing for null or empty references', () => {
    expect(draftSlugsFromReferences(null, MAIN)).toEqual([]);
    expect(draftSlugsFromReferences([], MAIN)).toEqual([]);
  });

  it('reads a thread slug with or without trailing slash, query or fragment', () => {
    expect(
      draftSlugsFromReferences(
        [
          ref('https://dreptalk.com/t/fund-tooling-a1b2/'),
          ref('https://dreptalk.com/t/other-draft-c3d4'),
          ref('https://dreptalk.com/t/third-e5f6/?page=2#post-abc'),
        ],
        MAIN,
      ),
    ).toEqual(['fund-tooling-a1b2', 'other-draft-c3d4', 'third-e5f6']);
  });

  it('only accepts the running network origin over https', () => {
    expect(draftSlugsFromReferences([ref('https://preprod.dreptalk.com/t/x-a1b2/')], MAIN)).toEqual([]);
    expect(draftSlugsFromReferences([ref('http://dreptalk.com/t/x-a1b2/')], MAIN)).toEqual([]);
    expect(draftSlugsFromReferences([ref('https://evil.example/t/x-a1b2/')], MAIN)).toEqual([]);
    expect(draftSlugsFromReferences([ref('https://preprod.dreptalk.com/t/x-a1b2/')], 'https://preprod.dreptalk.com')).toEqual(['x-a1b2']);
  });

  it('ignores other paths and garbage', () => {
    expect(
      draftSlugsFromReferences(
        [
          ref('https://dreptalk.com/c/proposal-drafts/'),
          ref('https://dreptalk.com/t/'),
          ref('https://dreptalk.com/t/a/b/'),
          ref('https://dreptalk.com/cip100/topic/abc.json'),
          ref('ipfs://bafyfoo'),
          ref('not a url'),
        ],
        MAIN,
      ),
    ).toEqual([]);
  });

  it('accepts the thread URL built from each network config, as the hint box shows it', () => {
    for (const network of ['mainnet', 'preprod'] as const) {
      const origin = resolveNetwork(network).siteOrigin;
      expect(draftSlugsFromReferences([ref(`${origin}/t/my-draft-a1b2/`)], origin)).toEqual(['my-draft-a1b2']);
    }
  });

  it('keeps reference order and drops duplicates', () => {
    expect(
      draftSlugsFromReferences([ref('https://dreptalk.com/t/b-2/'), ref('https://dreptalk.com/t/a-1/'), ref('https://dreptalk.com/t/b-2')], MAIN),
    ).toEqual(['b-2', 'a-1']);
  });
});
