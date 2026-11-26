import { describe, it, expect } from 'vitest';
import { buildCcPositions, buildUncountedCcPositions } from './ccPositions.js';
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

describe('buildUncountedCcPositions', () => {
  // An interim committee (epochs 0 to 579) replaced at 580: one seat stays with
  // its credential, one comes back under a new credential, one is removed.
  const change = [
    { coldKeyHex: 'coldkeep', versionFrom: 0, versionTo: 579, termExpiration: 900, authorizedFrom: 0, resignedAt: null },
    { coldKeyHex: 'coldjpold', versionFrom: 0, versionTo: 579, termExpiration: 900, authorizedFrom: 0, resignedAt: null },
    { coldKeyHex: 'coldgone', versionFrom: 0, versionTo: 579, termExpiration: 900, authorizedFrom: 0, resignedAt: null },
    { coldKeyHex: 'coldkeep', versionFrom: 580, versionTo: null, termExpiration: 900, authorizedFrom: 0, resignedAt: null },
    { coldKeyHex: 'coldjpnew', versionFrom: 580, versionTo: null, termExpiration: 900, authorizedFrom: 570, resignedAt: null },
  ];
  const changeHot = new Map([['hotkeep', 'coldkeep'], ['hotjpold', 'coldjpold'], ['hotgone', 'coldgone'], ['hotjpnew', 'coldjpnew']]);
  const changeNames = buildCcNameIndex(
    [{ hotKeyHex: 'hotjpold', name: 'Japan Council', sourceBlockTime: 10 }, { hotKeyHex: 'hotgone', name: 'Gone Council', sourceBlockTime: 10 }],
    changeHot,
  );
  const votes = [
    { voterId: 'vKeep', hotKeyHex: 'hotkeep', vote: 'Yes' as const, blockTime: 10, metaUrl: null },
    { voterId: 'vJp', hotKeyHex: 'hotjpold', vote: 'No' as const, blockTime: 11, metaUrl: 'https://jp' },
    { voterId: 'vGoneOld', hotKeyHex: 'hotgone', vote: 'Yes' as const, blockTime: 5, metaUrl: null },
    { voterId: 'vGone', hotKeyHex: 'hotgone', vote: 'Abstain' as const, blockTime: 12, metaUrl: 'https://gone' },
    { voterId: 'vUnknown', hotKeyHex: 'hotunknown', vote: 'Yes' as const, blockTime: 13, metaUrl: null },
  ];
  const rationales = new Map([['vGone', { bodyHtml: '<p>last act</p>', status: 'ok' }]]);

  it('keeps ballots of credentials not counted at the boundary, one per credential, out of the counted rows', () => {
    const counted = buildCcPositions({ members: change, hotToCold: changeHot, votes, epoch: 581, currentEpoch: 600, nameIndex: changeNames, rationales });
    expect(counted.map((r) => [r.coldKeyHex, r.vote])).toEqual([['coldkeep', 'Yes'], ['coldjpnew', null]]);

    const uncounted = buildUncountedCcPositions({ members: change, hotToCold: changeHot, votes, epoch: 581, nameIndex: changeNames, rationales });
    expect(uncounted.map((r) => [r.coldKeyHex, r.hotKeyHex, r.voterId, r.displayName, r.vote, r.rationale])).toEqual([
      [null, 'hotunknown', 'vUnknown', null, 'Yes', 'none'],
      ['coldjpold', 'hotjpold', 'vJp', 'Japan Council', 'No', 'unavailable'],
      ['coldgone', 'hotgone', 'vGone', 'Gone Council', 'Abstain', 'view'],
    ]);
    expect(uncounted[2].bodyHtml).toBe('<p>last act</p>');
  });

  it('keeps a hot key without a cold credential as its own row with a null cold key', () => {
    const uncounted = buildUncountedCcPositions({ members: change, hotToCold: changeHot, votes: [votes[4]], epoch: 581, nameIndex: changeNames, rationales });
    expect(uncounted).toHaveLength(1);
    expect(uncounted[0].coldKeyHex).toBeNull();
    expect(uncounted[0].hotKeyHex).toBe('hotunknown');
  });

  it('is empty before the committee change, when every ballot counts', () => {
    expect(buildUncountedCcPositions({ members: change, hotToCold: changeHot, votes: votes.slice(0, 4), epoch: 579, nameIndex: changeNames, rationales })).toEqual([]);
  });

  it('is empty when the boundary or the committee is unknown', () => {
    expect(buildUncountedCcPositions({ members: change, hotToCold: changeHot, votes, epoch: null, nameIndex: changeNames, rationales })).toEqual([]);
    expect(buildUncountedCcPositions({ members: [], hotToCold: changeHot, votes, epoch: 581, nameIndex: changeNames, rationales })).toEqual([]);
  });
});
