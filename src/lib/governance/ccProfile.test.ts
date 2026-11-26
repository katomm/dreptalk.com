import { describe, expect, it } from 'vitest';
import { buildCcIndex, buildCcMemberProfile, countReadableRationales, currentCcStanding } from './ccProfile.js';
import { buildCcPanel } from '../analytics/ccPanelView.js';
import { consideredCcActions } from '../analytics/ccParticipation.js';
import { ccRationaleKey } from '../db/actionRationale.js';
import type { CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import type { CcVoteRow, DecidedCcAction, OpenCcVoteRow } from '../db/committee.js';
import type { CcNameIndex } from './ccNames.js';

// cold1 serves throughout, cold2 resigns in epoch 610, so it counts at the
// boundaries of 600 and 610 and is out at 620.
const members: CommitteeMemberTerm[] = [
  { coldKeyHex: 'cold1', versionFrom: 500, versionTo: null, termExpiration: 900, authorizedFrom: 500, resignedAt: null },
  { coldKeyHex: 'cold2', versionFrom: 500, versionTo: null, termExpiration: 900, authorizedFrom: 500, resignedAt: 610 },
];
const hotToCold = new Map([
  ['hot1', 'cold1'],
  ['hot1b', 'cold1'],
  ['hot2', 'cold2'],
]);
const nameIndex: CcNameIndex = {
  byHot: () => null,
  byCold: (c: string) => (c === 'cold1' ? 'Alice Org' : null),
  sourceByCold: (c: string) => (c === 'cold1' ? { kind: 'declared' } : null),
};

const action = (over: Partial<DecidedCcAction>): DecidedCcAction => ({
  gaId: 'ga1', title: 'T', topicSlug: 't', type: 'InfoAction', status: 'closed', decidedEpoch: 600, ratifiedEpoch: null, expiryEpoch: null,
  submittedAt: 0, ccYesPct: 100, thresholdsJson: '{"cc":66.7,"ccBelowMinSize":false,"v":2}',
  ...over,
});
const vote = (hot: string, v: 'Yes' | 'No' | 'Abstain', blockTime: number | null, voterId = hot): CcVoteRow => ({
  voterId, hotKeyHex: hot, vote: v, blockTime, metaUrl: null,
});

const actions = [
  action({ gaId: 'ga1', decidedEpoch: 600 }),
  action({ gaId: 'ga2', decidedEpoch: 610 }),
  action({ gaId: 'ga3', decidedEpoch: 620 }),
];
const votesByAction = new Map<string, CcVoteRow[]>([
  // cold1 votes twice under two hot keys, the later ballot wins.
  ['ga1', [vote('hot1', 'No', 10, 'v1-early'), vote('hot1b', 'Yes', 20, 'v1-late'), vote('hot2', 'Abstain', 15)]],
  ['ga2', [vote('hot1', 'Yes', 30)]],
  // cold2 resigned before this boundary, its ballot is not counted.
  ['ga3', [vote('hot1', 'No', 40), vote('hot2', 'Yes', 41, 'v2-late')]],
]);
const currentEpoch = 650;
const { considered } = consideredCcActions({ actions, votesByAction, members, hotToCold, currentEpoch });

const profile = (coldKeyHex: string, over: Partial<Parameters<typeof buildCcMemberProfile>[0]> = {}) =>
  buildCcMemberProfile({ coldKeyHex, considered, members, hotToCold, nameIndex, currentEpoch, openVotes: [], ...over });

describe('buildCcMemberProfile', () => {
  it('matches the panel voted and eligible for every member', () => {
    const panel = buildCcPanel({ actions, votesByAction, members, hotToCold, nameIndex, currentEpoch });
    expect(panel.members.length).toBe(2);
    for (const row of panel.members) {
      const p = profile(row.coldKeyHex);
      expect(p).not.toBeNull();
      expect(p?.voted).toBe(row.voted);
      expect(p?.eligible).toBe(row.eligible);
      expect(p?.sequence).toEqual(row.sequence);
      expect(p?.tenure).toEqual(row.tenure);
    }
    const alice = profile('cold1');
    expect(alice).toMatchObject({ name: 'Alice Org', nameSource: { kind: 'declared' }, voted: 3, eligible: 3, pct: 100 });
    expect(alice?.counts).toEqual({ yes: 2, no: 1, abstain: 0 });
    expect(alice?.hotKeys).toEqual(['hot1', 'hot1b']);
    // Newest first, each row carries the winning ballot.
    expect(alice?.record.map((r) => r.gaId)).toEqual(['ga3', 'ga2', 'ga1']);
    expect(alice?.record[2].vote?.voterId).toBe('v1-late');
  });

  it('lists a ballot from a credential not counted at the boundary under uncounted, outside X and Y', () => {
    const p = profile('cold2');
    expect(p).toMatchObject({ voted: 1, eligible: 2, standing: 'Resigned' });
    expect(p?.sequence).toEqual(['voted', 'missed', 'ineligible']);
    expect(p?.record.map((r) => r.gaId)).toEqual(['ga2', 'ga1']);
    expect(p?.record[0].vote).toBeNull();
    expect(p?.uncounted.map((r) => [r.gaId, r.vote?.voterId])).toEqual([['ga3', 'v2-late']]);
    expect(p?.record.some((r) => r.gaId === 'ga3')).toBe(false);
  });

  it('returns eligible 0 and pct null for a seat without considered actions', () => {
    const late: CommitteeMemberTerm = { coldKeyHex: 'cold3', versionFrom: 630, versionTo: null, termExpiration: 900, authorizedFrom: 630, resignedAt: null };
    const p = profile('cold3', { members: [...members, late] });
    expect(p).toMatchObject({ voted: 0, eligible: 0, pct: null, record: [], uncounted: [] });
    expect(p?.sequence).toEqual(['ineligible', 'ineligible', 'ineligible']);
  });

  it('returns null for a cold key without any term', () => {
    expect(profile('nobody')).toBeNull();
  });

  it('keeps a record row without topic slug or title', () => {
    const bare = [action({ gaId: 'gaX', title: null, topicSlug: null })];
    const c = consideredCcActions({ actions: bare, votesByAction: new Map(), members, hotToCold, currentEpoch }).considered;
    const p = profile('cold1', { considered: c });
    expect(p?.record).toEqual([
      { gaId: 'gaX', title: null, topicSlug: null, type: 'InfoAction', status: 'closed', decidedEpoch: 600, vote: null },
    ]);
  });

  it('shows open votes only for a current member, latest vote per action', () => {
    const open = (gaId: string, hot: string, blockTime: number, type = 'InfoAction'): OpenCcVoteRow => ({
      ...vote(hot, 'Yes', blockTime, `${gaId}-${hot}-${blockTime}`), gaId, title: `Open ${gaId}`, topicSlug: null, type,
    });
    const openVotes = [
      open('oa1', 'hot1', 100),
      open('oa1', 'hot1b', 200),
      open('oa2', 'hot1', 150),
      open('oa1', 'hot2', 300),
      // Not CC eligible, never listed.
      open('oa3', 'hot1', 400, 'NoConfidence'),
    ];
    const alice = profile('cold1', { openVotes });
    expect(alice?.open.map((o) => [o.gaId, o.vote.voterId])).toEqual([
      ['oa1', 'oa1-hot1b-200'],
      ['oa2', 'oa2-hot1-150'],
    ]);
    expect(alice?.open[0].title).toBe('Open oa1');
    expect(profile('cold2', { openVotes })?.open).toEqual([]);
    expect(profile('cold1', { openVotes, currentEpoch: null })?.open).toEqual([]);
  });
});

describe('currentCcStanding', () => {
  const interim: CommitteeMemberTerm = { coldKeyHex: 'interim', versionFrom: 507, versionTo: 580, termExpiration: 900, authorizedFrom: 507, resignedAt: null };
  const carry: CommitteeMemberTerm[] = [
    { coldKeyHex: 'carry', versionFrom: 507, versionTo: 580, termExpiration: 900, authorizedFrom: 507, resignedAt: null },
    { coldKeyHex: 'carry', versionFrom: 654, versionTo: null, termExpiration: 800, authorizedFrom: 654, resignedAt: null },
  ];
  const resigned: CommitteeMemberTerm = { coldKeyHex: 'gone', versionFrom: 654, versionTo: null, termExpiration: 800, authorizedFrom: 654, resignedAt: 690 };
  const all = [interim, ...carry, resigned];

  it('reads Former, Active and Resigned at the next transition', () => {
    expect(currentCcStanding(all, 'interim', 700)).toBe('Former');
    expect(currentCcStanding(all, 'carry', 700)).toBe('Active');
    expect(currentCcStanding(all, 'gone', 700)).toBe('Resigned');
  });

  it('reads Expired once the term has run out', () => {
    expect(currentCcStanding(all, 'carry', 800)).toBe('Expired');
  });

  it('without a current epoch only tells a seat that has no open term', () => {
    expect(currentCcStanding(all, 'interim', null)).toBe('Former');
    expect(currentCcStanding(all, 'carry', null)).toBeNull();
  });
});

describe('countReadableRationales', () => {
  it('counts only view rationales of counted final votes', () => {
    const states = new Map([
      [ccRationaleKey('ga1', 'v1-late'), { hasBody: true, status: 'ok' }],
      // The losing earlier ballot under another hot key.
      [ccRationaleKey('ga1', 'v1-early'), { hasBody: true, status: 'ok' }],
      // An ok row without a body is not readable.
      [ccRationaleKey('ga2', 'hot1'), { hasBody: false, status: 'ok' }],
      [ccRationaleKey('ga3', 'hot1'), { hasBody: true, status: 'failed' }],
      // cold2's uncounted ballot.
      [ccRationaleKey('ga3', 'v2-late'), { hasBody: true, status: 'ok' }],
    ]);
    expect(countReadableRationales(profile('cold1')?.record ?? [], states)).toBe(1);
    expect(countReadableRationales(profile('cold2')?.record ?? [], states)).toBe(0);
  });
});

describe('buildCcIndex', () => {
  it('puts Former seats after current ones and keeps a seat without actions', () => {
    const extra: CommitteeMemberTerm[] = [
      { coldKeyHex: 'aaFormer', versionFrom: 500, versionTo: 580, termExpiration: 900, authorizedFrom: 500, resignedAt: null },
      { coldKeyHex: 'cold3', versionFrom: 630, versionTo: null, termExpiration: 900, authorizedFrom: 630, resignedAt: null },
    ];
    const rows = buildCcIndex({ considered, members: [...members, ...extra], hotToCold, nameIndex, currentEpoch });
    // Non-Former by name or cold key (case-insensitive), then Former.
    expect(rows.map((r) => [r.coldKeyHex, r.standing])).toEqual([
      ['cold1', 'Active'],
      ['cold2', 'Resigned'],
      ['cold3', 'Active'],
      ['aaFormer', 'Former'],
    ]);
    const alice = rows.find((r) => r.coldKeyHex === 'cold1');
    expect(alice).toMatchObject({ name: 'Alice Org', voted: 3, eligible: 3, tenure: { from: 500, to: null } });
    expect(rows.find((r) => r.coldKeyHex === 'cold3')?.eligible).toBe(0);
    expect(rows.find((r) => r.coldKeyHex === 'cold2')).toMatchObject({ voted: 1, eligible: 2 });
  });
});
