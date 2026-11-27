import { describe, expect, it } from 'vitest';
import type { CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import type { CcIndexRow } from './ccProfile.js';
import { buildCcFacts, buildCcTimeline, timelineSpan } from './ccOverview.js';

const term = (coldKeyHex: string, over: Partial<CommitteeMemberTerm> = {}): CommitteeMemberTerm => ({
  coldKeyHex,
  versionFrom: 507,
  versionTo: null,
  termExpiration: 580,
  authorizedFrom: 507,
  resignedAt: null,
  ...over,
});

const row = (coldKeyHex: string, over: Partial<CcIndexRow> = {}): CcIndexRow => ({
  coldKeyHex,
  name: coldKeyHex.toUpperCase(),
  standing: 'Active',
  tenure: { from: 507, to: null },
  voted: 0,
  eligible: 0,
  ...over,
});

describe('buildCcFacts', () => {
  it('counts active seats and picks the earliest open term end', () => {
    const members = [term('a', { termExpiration: 600 }), term('b', { termExpiration: 580 }), term('c', { versionTo: 550, termExpiration: 540 })];
    const rows = [row('a'), row('b'), row('c', { standing: 'Former', tenure: { from: 507, to: 540 } })];
    const facts = buildCcFacts({ rows, members, minSize: 7, threshold: 2 / 3, maxTermEpochs: 146 });
    expect(facts.activeSeats).toBe(2);
    expect(facts.nextTermEnd).toEqual({ coldKeyHex: 'b', name: 'B', epoch: 580 });
    expect(facts.thresholdPct).toBeCloseTo(66.67, 1);
    expect(facts.minSize).toBe(7);
    expect(facts.maxTermEpochs).toBe(146);
  });

  it('keeps unknown parameters null', () => {
    const facts = buildCcFacts({ rows: [], members: [], minSize: null, threshold: null, maxTermEpochs: null });
    expect(facts).toEqual({ activeSeats: 0, minSize: null, thresholdPct: null, maxTermEpochs: null, nextTermEnd: null });
  });
});

describe('buildCcTimeline', () => {
  it('runs active seats to now and projects the rest of the term', () => {
    const members = [term('a', { termExpiration: 620 }), term('c', { versionTo: 550 })];
    const rows = [row('a', { tenure: { from: 510, to: null } }), row('c', { standing: 'Former', tenure: { from: 507, to: 550 } })];
    const t = buildCcTimeline(rows, members, 600);
    expect(t?.bars).toEqual([
      { coldKeyHex: 'a', name: 'A', standing: 'Active', from: 510, servedTo: 600, termEnd: 620 },
      { coldKeyHex: 'c', name: 'C', standing: 'Former', from: 507, servedTo: 550, termEnd: null },
    ]);
    expect(t?.start).toBe(507);
    expect(t?.end).toBe(621);
    expect(t?.ticks).toEqual([525, 550, 575, 600]);
  });

  it('needs a current epoch', () => {
    expect(buildCcTimeline([row('a')], [term('a')], null)).toBeNull();
  });

  it('maps an epoch range to percentages, inclusive of the last epoch', () => {
    const t = { start: 500, end: 600, now: 550, bars: [], ticks: [] };
    expect(timelineSpan(t, 500, 549)).toEqual({ left: 0, width: 50 });
  });
});
