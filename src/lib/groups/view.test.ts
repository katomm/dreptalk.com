import { describe, expect, it } from 'vitest';
import {
  addressStatusLabel,
  describePolicy,
  eventLabel,
  hostedAvatarHash,
  memberSections,
  modeLabel,
  policyKeyHashes,
  reasonLabel,
  scriptFromJson,
  shortHash,
  statusNoteLabel,
} from './view.js';

const K = (n: number) => n.toString(16).padStart(2, '0').repeat(28);
const json = JSON.stringify({
  type: 'nOfK',
  n: '2',
  scripts: [
    { type: 'sig', keyHash: K(1) },
    { type: 'sig', keyHash: K(2) },
    { type: 'sig', keyHash: K(3) },
  ],
});

describe('group view helpers', () => {
  it('describes a threshold policy with known names', () => {
    const s = scriptFromJson(json);
    expect(
      describePolicy(
        s,
        new Map([
          [K(1), 'Alice'],
          [K(2), 'Bob'],
        ]),
      ),
    ).toBe(`2 of 3: Alice, Bob, ${shortHash(K(3))}`);
    expect(policyKeyHashes(s)).toEqual([K(1), K(2), K(3)]);
  });

  it('marks group admins in a treasury policy', () => {
    expect(describePolicy(scriptFromJson(json), new Map([[K(1), 'Alice']]), new Set([K(1)]))).toBe(
      `2 of 3: Alice (group admin), ${shortHash(K(2))}, ${shortHash(K(3))}`,
    );
  });

  it('describes nested, time-locked and too deep policies', () => {
    const nested = scriptFromJson(
      JSON.stringify({
        type: 'all',
        scripts: [
          { type: 'sig', keyHash: K(1) },
          { type: 'after', slot: '100' },
        ],
      }),
    );
    expect(describePolicy(nested, new Map())).toBe(`all of: ${shortHash(K(1))}, valid from slot 100`);
    expect(describePolicy(scriptFromJson('{"type":"tooDeep"}'), new Map())).toBe('Policy too deeply nested to display');
    expect(describePolicy(null, new Map())).toBe('Unknown policy');
    expect(scriptFromJson('not json')).toBeNull();
    expect(scriptFromJson(undefined)).toBeNull();
  });

  it('labels follow the presentation guidance', () => {
    expect(modeLabel('open')).toBe('Open, self-declared');
    expect(modeLabel('permissioned')).toBe('Permissioned, confirmed by the group');
    expect(reasonLabel('retired')).toBe('DRep retired');
    expect(reasonLabel(null)).toBe('');
    expect(eventLabel('join')).toBe('Joined');
    expect(eventLabel(null)).toBe('Unreadable event');
    expect(addressStatusLabel('script-controlled')).toBe('Controlled by');
    expect(addressStatusLabel('declared')).toBe('Declared address');
    expect(shortHash(K(1))).toBe(`${K(1).slice(0, 8)}...${K(1).slice(-4)}`);
    expect(shortHash('abcd')).toBe('abcd');
  });

  it('words the status notes', () => {
    expect(statusNoteLabel('correcting')).toBe(
      'Group data is being corrected after a chain reorganization. Some entries may be out of date for a few minutes.',
    );
    expect(statusNoteLabel('rebuilding')).toBe('Group data is being rebuilt. Lists fill up again over the next runs.');
    expect(statusNoteLabel(null)).toBeNull();
  });

  it('gives a closing group one member list keyed by members', () => {
    const params = new URLSearchParams('members=10.0.2.0&active=5.0.2.0');
    expect(memberSections({ closing: true }, params)).toEqual([{ kind: 'all', after: '10.0.2.0' }]);
    expect(memberSections({ closing: true }, new URLSearchParams())).toEqual([{ kind: 'all', after: null }]);
  });

  it('gives any other group three sections keyed by their kind', () => {
    const params = new URLSearchParams('active=5.0.2.0&former=7.1.2.0&members=10.0.2.0');
    expect(memberSections({ closing: false }, params)).toEqual([
      { kind: 'active', after: '5.0.2.0' },
      { kind: 'pending', after: null },
      { kind: 'former', after: '7.1.2.0' },
    ]);
  });
});

describe('hostedAvatarHash', () => {
  const h = 'ab'.repeat(32);
  it('reads the hash of an image the site hosts, on any origin', () => {
    expect(hostedAvatarHash(`https://dreptalk.com/api/avatar/${h}`)).toBe(h);
    expect(hostedAvatarHash(`http://localhost:4321/api/avatar/${h}/thumb`)).toBe(h);
  });
  it('leaves out other images and anything that is not a web link', () => {
    expect(hostedAvatarHash('https://example.com/logo.png')).toBeNull();
    expect(hostedAvatarHash(`ipfs://api/avatar/${h}`)).toBeNull();
    expect(hostedAvatarHash(`https://dreptalk.com/api/avatar/${h.toUpperCase()}`)).toBeNull();
    expect(hostedAvatarHash('not a url')).toBeNull();
    expect(hostedAvatarHash(null)).toBeNull();
  });
});
