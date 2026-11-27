import { describe, expect, it } from 'vitest';
import type { CcTimeline } from '../governance/ccOverview.js';
import { CC_CARD_TIMELINE_WIDTH, ccMemberCardModel, ccMemberCardVersion, ccOverviewCardModel, ccOverviewCardVersion, type CcMemberCardInput } from './ccCard.js';
import { ccOverviewCardHtml } from './templates.js';

const member: CcMemberCardInput = {
  coldKeyHex: 'ab'.repeat(28),
  name: 'Ace Alliance',
  standing: 'Active',
  tenure: { from: 582, to: null },
  voted: 61,
  eligible: 62,
  counts: { yes: 53, no: 7, abstain: 1 },
  readable: 58,
};

describe('ccMemberCardModel', () => {
  it('shows the record, the rationale share and the standing', () => {
    const m = ccMemberCardModel(member, { avatarDataUrl: 'data:x' });
    expect(m.name).toBe('Ace Alliance');
    expect(m.bio).toBe('Yes 53, No 7, Abstain 1');
    expect(m.stats.map((s) => [s.value, s.label])).toEqual([
      ['61 of 62', 'actions voted on'],
      ['58 of 61', 'votes with a rationale'],
      ['Active', 'since epoch 582'],
    ]);
  });

  it('falls back to the short key and drops the rationale stat without votes', () => {
    const m = ccMemberCardModel({ ...member, name: null, voted: 0, eligible: 0, counts: { yes: 0, no: 0, abstain: 0 }, readable: 0 }, { avatarDataUrl: 'data:x' });
    expect(m.name).toMatch(/^abab/);
    expect(m.idShort).toBeNull();
    expect(m.bio).toBeNull();
    expect(m.stats.map((s) => s.value)).toEqual(['None yet', 'Active']);
  });

  it('versions on every shown field', () => {
    expect(ccMemberCardVersion(member)).not.toBe(ccMemberCardVersion({ ...member, voted: 62 }));
    expect(ccMemberCardVersion(member)).toBe(ccMemberCardVersion({ ...member }));
  });
});

describe('ccOverviewCardModel', () => {
  const facts = { activeSeats: 7, minSize: 5, thresholdPct: 200 / 3, maxTermEpochs: 146, nextTermEnd: { coldKeyHex: 'a', name: 'A', epoch: 726 } };
  const timeline: CcTimeline = {
    start: 500,
    end: 700,
    now: 600,
    ticks: [],
    bars: [
      { coldKeyHex: 'a', name: 'A', standing: 'Former', from: 500, servedTo: 549, termEnd: null },
      { coldKeyHex: 'b', name: 'B', standing: 'Active', from: 550, servedTo: 600, termEnd: 699 },
    ],
  };

  it('maps seats to pixels across the timeline width', () => {
    const m = ccOverviewCardModel(facts, timeline);
    expect(m.subtitle).toBe('7 active seats, 66.7% Yes needed, next term ends in epoch 726');
    expect(m.bars).toEqual([
      { offset: 0, served: CC_CARD_TIMELINE_WIDTH / 4, rest: 0, active: false },
      { offset: CC_CARD_TIMELINE_WIDTH / 4, served: Math.round((51 / 200) * CC_CARD_TIMELINE_WIDTH), rest: Math.round((99 / 200) * CC_CARD_TIMELINE_WIDTH), active: true },
    ]);
    expect(m.nowX).toBe(CC_CARD_TIMELINE_WIDTH / 2);
    expect(ccOverviewCardHtml(m)).toContain('Constitutional Committee');
  });

  it('changes its version when the epoch moves', () => {
    const a = ccOverviewCardVersion(ccOverviewCardModel(facts, timeline));
    const b = ccOverviewCardVersion(ccOverviewCardModel(facts, { ...timeline, now: 610 }));
    expect(a).not.toBe(b);
  });
});
