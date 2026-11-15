import { describe, expect, it } from 'vitest';
import {
  type DrepOrderRow,
  drepListHref,
  drepListPage,
  explicitDrepListSort,
  firstGroupMiss,
  firstGroupStandingLine,
  orderDrepList,
  parseDrepListSort,
  utcDayKey,
  wholePercent,
} from './listOrder';

const FLOOR = 25_000_000_000n;
const DAY = '2026-11-15';

function row(id: string, over: Partial<DrepOrderRow> = {}): DrepOrderRow {
  return {
    drepId: id,
    active: true,
    hasName: true,
    votingPower: '30000000000',
    doNotList: false,
    participationPct: 80,
    rationalePct: 50,
    ...over,
  };
}

describe('parseDrepListSort', () => {
  it('defaults to active for missing and unknown values', () => {
    expect(parseDrepListSort(null)).toBe('active');
    expect(parseDrepListSort('foo')).toBe('active');
    expect(parseDrepListSort('power')).toBe('power');
    expect(parseDrepListSort('delegators')).toBe('delegators');
  });
  it('explicitDrepListSort is null unless the value is valid', () => {
    expect(explicitDrepListSort(null)).toBeNull();
    expect(explicitDrepListSort('')).toBeNull();
    expect(explicitDrepListSort('foo')).toBeNull();
    expect(explicitDrepListSort('active')).toBe('active');
    expect(explicitDrepListSort('power')).toBe('power');
    expect(explicitDrepListSort('delegators')).toBe('delegators');
  });
});

describe('wholePercent', () => {
  it('rounds down', () => {
    expect(wholePercent(69.5)).toBe(69);
    expect(wholePercent(99.99)).toBe(99);
    expect(wholePercent(70)).toBe(70);
    expect(wholePercent(0)).toBe(0);
  });
  it('does not read an exact ratio stored as a float one point low', () => {
    expect(wholePercent((29 / 50) * 100)).toBe(58);
    expect(wholePercent(69.5)).toBe(69);
  });
});

describe('firstGroupMiss', () => {
  it('is null for a row that meets every condition', () => {
    expect(firstGroupMiss(row('a'), FLOOR)).toBeNull();
  });
  it('names each failing condition', () => {
    expect(firstGroupMiss(row('a', { active: false }), FLOOR)).toBe('inactive');
    expect(firstGroupMiss(row('a', { hasName: false }), FLOOR)).toBe('no_name');
    expect(firstGroupMiss(row('a', { votingPower: '24999999999' }), FLOOR)).toBe('below_floor');
    expect(firstGroupMiss(row('a', { votingPower: null }), FLOOR)).toBe('below_floor');
    expect(firstGroupMiss(row('a', { votingPower: 'junk' }), FLOOR)).toBe('below_floor');
    expect(firstGroupMiss(row('a', { participationPct: null }), FLOOR)).toBe('no_report_card');
    expect(firstGroupMiss(row('a', { participationPct: 69.9 }), FLOOR)).toBe('below_threshold');
    expect(firstGroupMiss(row('a', { doNotList: true }), FLOOR)).toBe('do_not_list');
  });
  it('accepts exactly 70 and exactly the floor', () => {
    expect(firstGroupMiss(row('a', { participationPct: 70, votingPower: '25000000000' }), FLOOR)).toBeNull();
  });
  it('reports the first failing condition when several fail', () => {
    // An inactive DRep with a stale report card row and no name.
    expect(firstGroupMiss(row('a', { active: false, hasName: false }), FLOOR)).toBe('inactive');
    // A new DRep: 4 of 4 voted, no report card row yet.
    expect(firstGroupMiss(row('a', { participationPct: null, doNotList: true }), FLOOR)).toBe('no_report_card');
    expect(firstGroupMiss(row('a', { hasName: false, votingPower: '0' }), FLOOR)).toBe('no_name');
    expect(firstGroupMiss(row('a', { votingPower: '0', participationPct: null }), FLOOR)).toBe('below_floor');
    expect(firstGroupMiss(row('a', { participationPct: 50, doNotList: true }), FLOOR)).toBe('below_threshold');
  });
});

describe('utcDayKey', () => {
  it('uses the UTC date', () => {
    expect(utcDayKey(Date.UTC(2026, 10, 15, 23, 59, 59))).toBe('2026-11-15');
    expect(utcDayKey(Date.UTC(2026, 10, 16, 0, 0, 0))).toBe('2026-11-16');
  });
});

describe('orderDrepList', () => {
  const first = Array.from({ length: 30 }, (_, i) => row(`in${i}`));
  const rest = [
    row('r_hi', { hasName: false, participationPct: 95 }),
    row('r_mid_big', { participationPct: 60, votingPower: '900' }),
    row('r_mid_small', { participationPct: 60, votingPower: '100' }),
    row('r_tie_a', { participationPct: 50, votingPower: '0' }),
    row('r_tie_b', { participationPct: 50, votingPower: '0' }),
    // Voted on nothing, but has a report card: still ahead of every DRep without one.
    row('r_zero', { participationPct: 0, votingPower: '1' }),
    // These two powers are the same value as Number. The larger one has the later id,
    // so only a BigInt comparison puts it first.
    row('r_nocard_a', { participationPct: null, votingPower: '9007199254740992' }),
    row('r_nocard_b', { participationPct: null, votingPower: '9007199254740993' }),
  ];
  const all = [...first, ...rest];

  it('puts the first group first and reports its size', () => {
    const out = orderDrepList(all, { day: DAY, floorLovelace: FLOOR });
    expect(out.firstGroupSize).toBe(30);
    expect(new Set(out.ids.slice(0, 30))).toEqual(new Set(first.map((r) => r.drepId)));
  });
  it('orders the rest by participation, then power as BigInt, then id, no report card last', () => {
    const out = orderDrepList(all, { day: DAY, floorLovelace: FLOOR });
    expect(out.ids.slice(30)).toEqual([
      'r_hi', 'r_mid_big', 'r_mid_small', 'r_tie_a', 'r_tie_b', 'r_zero', 'r_nocard_b', 'r_nocard_a',
    ]);
  });
  it('does not depend on the input order', () => {
    const a = orderDrepList(all, { day: DAY, floorLovelace: FLOOR }).ids;
    const b = orderDrepList([...all].reverse(), { day: DAY, floorLovelace: FLOOR }).ids;
    expect(b).toEqual(a);
  });
  it('changes the first group order from one day to the next', () => {
    const a = orderDrepList(first, { day: '2026-11-15', floorLovelace: FLOOR }).ids;
    const b = orderDrepList(first, { day: '2026-11-16', floorLovelace: FLOOR }).ids;
    expect(b).not.toEqual(a);
    expect(new Set(b)).toEqual(new Set(a));
  });
  it('keeps everyone else in relative order when one member leaves the first group', () => {
    const before = orderDrepList(first, { day: DAY, floorLovelace: FLOOR }).ids;
    const gone = before[4];
    const after = orderDrepList(first.filter((r) => r.drepId !== gone), { day: DAY, floorLovelace: FLOOR }).ids;
    expect(after).toEqual(before.filter((id) => id !== gone));
  });
  it('loses and doubles no row across pages of 50', () => {
    const many = Array.from({ length: 120 }, (_, i) => row(`m${i}`, { participationPct: i % 3 === 0 ? 50 : 80 }));
    const ids = orderDrepList(many, { day: DAY, floorLovelace: FLOOR }).ids;
    const pages = [ids.slice(0, 50), ids.slice(50, 100), ids.slice(100, 150)].flat();
    expect(pages).toHaveLength(120);
    expect(new Set(pages).size).toBe(120);
  });
  it('handles an empty first group and an empty list', () => {
    expect(orderDrepList([], { day: DAY, floorLovelace: FLOOR })).toEqual({ ids: [], firstGroupSize: 0 });
    const out = orderDrepList(rest, { day: DAY, floorLovelace: FLOOR });
    expect(out.firstGroupSize).toBe(0);
    expect(out.ids[0]).toBe('r_hi');
  });
});

describe('drepListPage', () => {
  const ids = Array.from({ length: 90 }, (_, i) => `d${i + 1}`);

  it('puts the divider on the page where the first group ends', () => {
    expect(drepListPage(ids, 55, 0, 50)).toEqual({ pageIds: ids.slice(0, 50), dividerBeforeId: null, hasNext: true });
    expect(drepListPage(ids, 55, 50, 50)).toEqual({ pageIds: ids.slice(50, 90), dividerBeforeId: 'd56', hasNext: false });
  });
  it('makes the divider the first row of the next page when the group ends at a page end', () => {
    expect(drepListPage(ids, 50, 0, 50).dividerBeforeId).toBeNull();
    expect(drepListPage(ids, 50, 50, 50).dividerBeforeId).toBe('d51');
  });
  it('has no divider for an empty first group or one that is the whole list', () => {
    expect(drepListPage(ids, 0, 0, 50).dividerBeforeId).toBeNull();
    expect(drepListPage(ids, 90, 50, 50).dividerBeforeId).toBeNull();
  });
  it('returns an empty page past the end', () => {
    expect(drepListPage(ids, 55, 1000, 50)).toEqual({ pageIds: [], dividerBeforeId: null, hasNext: false });
  });
});

describe('drepListHref', () => {
  const bare = { sortInUrl: null, all: false, group: null };
  const power = { sortInUrl: 'power' as const, all: false, group: null };

  it('keeps a bare URL bare', () => {
    expect(drepListHref(bare)).toBe('/dreps/');
    expect(drepListHref(bare, { page: 2 })).toBe('/dreps/?page=2');
    expect(drepListHref(bare, { all: true })).toBe('/dreps/?all=1');
  });
  it('keeps a sort that is in the URL on every in-list link', () => {
    expect(drepListHref(power, { page: 3 })).toBe('/dreps/?page=3&sort=power');
    expect(drepListHref(power, { all: true })).toBe('/dreps/?all=1&sort=power');
    expect(drepListHref({ ...power, all: true }, { all: false })).toBe('/dreps/?sort=power');
    // "Active only" on /dreps/?all=1 without a sort: the full path drops the filter.
    expect(drepListHref({ ...bare, all: true }, { all: false })).toBe('/dreps/');
    expect(drepListHref({ ...power, group: 'group1abc' }, { group: null })).toBe('/dreps/?sort=power');
  });
  it('makes every sort control link explicit and drops the page', () => {
    expect(drepListHref(power, { sort: 'active' })).toBe('/dreps/?sort=active');
    expect(drepListHref(bare, { sort: 'delegators' })).toBe('/dreps/?sort=delegators');
    expect(drepListHref({ sortInUrl: 'power', all: true, group: 'group1abc' }, { sort: 'active' }))
      .toBe('/dreps/?all=1&sort=active&group=group1abc');
  });
  it('keeps all and group across the pager', () => {
    expect(drepListHref({ sortInUrl: null, all: true, group: 'group1abc' }, { page: 2 }))
      .toBe('/dreps/?page=2&all=1&group=group1abc');
  });
});

describe('firstGroupStandingLine', () => {
  const F = 25_000_000_000n;
  it('words each case', () => {
    expect(firstGroupStandingLine(null, 82.4, F)).toBe('Voted on 82% of governance actions. In the first group.');
    expect(firstGroupStandingLine('inactive', 90, F)).toBe('Voted on 90% of governance actions. Not active, so not in the first group.');
    expect(firstGroupStandingLine('inactive', null, F)).toBe('Not active, so not in the first group.');
    expect(firstGroupStandingLine('no_name', 90, F)).toBe('Voted on 90% of governance actions. Not in the first group: your DRep metadata has no name.');
    expect(firstGroupStandingLine('no_name', null, F)).toBe('Not in the first group: your DRep metadata has no name.');
    expect(firstGroupStandingLine('below_floor', 90, F)).toBe('Voted on 90% of governance actions. Not in the first group: voting power is below 25,000 ada.');
    expect(firstGroupStandingLine('below_floor', null, F)).toBe('Not in the first group: voting power is below 25,000 ada.');
    expect(firstGroupStandingLine('no_report_card', null, F)).toBe('Not in the first group: no participation figure yet.');
    expect(firstGroupStandingLine('below_threshold', 61.6, F)).toBe('Voted on 61% of governance actions. The first group starts at 70%.');
    expect(firstGroupStandingLine('below_threshold', 69.5, F)).toBe('Voted on 69% of governance actions. The first group starts at 70%.');
    expect(firstGroupStandingLine('do_not_list', 90, F)).toBe('Voted on 90% of governance actions. Not in the first group: your DRep metadata sets doNotList.');
  });
});
