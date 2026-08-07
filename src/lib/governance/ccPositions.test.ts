import { describe, it, expect } from 'vitest';
import { buildCcPositions } from './ccPositions.js';
import { buildCcNameIndex } from './ccNames.js';

const members = [
  { coldKeyHex: 'colda', versionFrom: 0, versionTo: null, termExpiration: 900, authorizedFrom: 0, resignedAt: null },
  { coldKeyHex: 'coldb', versionFrom: 0, versionTo: null, termExpiration: 900, authorizedFrom: 0, resignedAt: null },
  { coldKeyHex: 'coldc', versionFrom: 0, versionTo: null, termExpiration: 600, authorizedFrom: 0, resignedAt: null },
];
const hotToCold = new Map([['hota', 'colda'], ['hotb', 'coldb'], ['hotc', 'coldc']]);
const nameIndex = buildCcNameIndex(
  [{ hotKeyHex: 'hota', name: 'Alpha Org', sourceBlockTime: 10 }, { hotKeyHex: 'hotb', name: 'Beta Org', sourceBlockTime: 10 }],
  hotToCold,
);

describe('buildCcPositions', () => {
  it('orders Yes,No,Abstain,Not voted; resolves names; marks rationale states; standing vs current epoch', () => {
    const rows = buildCcPositions({
      members, hotToCold,
      votes: [
        { voterId: 'vA', hotKeyHex: 'hota', vote: 'Yes', blockTime: 10, metaUrl: 'https://a' },
        { voterId: 'vB', hotKeyHex: 'hotb', vote: 'No', blockTime: 10, metaUrl: 'https://b' },
      ],
      epoch: 500, currentEpoch: 700, nameIndex,
      rationales: new Map([['vA', { bodyHtml: '<p>x</p>', status: 'ok' }], ['vB', { bodyHtml: null, status: 'failed' }]]),
    });
    expect(rows.map((r) => [r.coldKeyHex, r.vote, r.displayName, r.rationale, r.voterId])).toEqual([
      ['colda', 'Yes', 'Alpha Org', 'view', 'vA'],
      ['coldb', 'No', 'Beta Org', 'unavailable', 'vB'],
      ['coldc', null, null, 'none', null], // did not vote, term 600 < currentEpoch 700 -> Expired
    ]);
    expect(rows[2].standing).toBe('Expired');
  });

  it('dedupes hot-key rotation to the latest vote and drops inactive members', () => {
    const rows = buildCcPositions({
      members,
      hotToCold: new Map([['hota1', 'colda'], ['hota2', 'colda'], ['hotb', 'coldb'], ['hotc', 'coldc']]),
      votes: [
        { voterId: 'vOld', hotKeyHex: 'hota1', vote: 'No', blockTime: 5, metaUrl: null },
        { voterId: 'vNew', hotKeyHex: 'hota2', vote: 'Yes', blockTime: 30, metaUrl: null },
      ],
      epoch: 300, currentEpoch: 300, nameIndex, rationales: new Map(),
    });
    expect(rows.find((r) => r.coldKeyHex === 'colda')?.vote).toBe('Yes');
    expect(rows.find((r) => r.coldKeyHex === 'colda')?.voterId).toBe('vNew');
  });

  it('returns [] when the epoch is null (committee unknown)', () => {
    expect(buildCcPositions({ members, hotToCold, votes: [], epoch: null, currentEpoch: null, nameIndex, rationales: new Map() })).toEqual([]);
  });
});
