import { describe, it, expect } from 'vitest';
import { buildCoalitionTable, buildThresholdMarkers } from './thresholdMarkers.js';

// No shared ProtocolParams fixture existed in this file before this change
// (each test above builds its own partial object), so this fixture is new,
// built to match the plan's assumed dvt values exactly: treasury 0.67, hard
// fork 0.6, constitution 0.75, no confidence 0.67, committee normal 0.67,
// committee no-confidence 0.6, pp network/economic/technical 0.67, pp
// governance 0.75. No adjustment to the plan's expected pct/count/label
// values was needed.
const paramsFixture = {
  dvtTreasuryWithdrawal: 0.67,
  dvtHardFork: 0.6,
  dvtUpdateConstitution: 0.75,
  dvtMotionNoConfidence: 0.67,
  dvtCommitteeNormal: 0.67,
  dvtCommitteeNoConfidence: 0.6,
  dvtPpNetwork: 0.67,
  dvtPpEconomic: 0.67,
  dvtPpTechnical: 0.67,
  dvtPpGov: 0.75,
  syncedAt: 1735000000000,
} as never;

// byPercent fixture: index = percent, count = index rounded up to tens for
// recognizable expectations (0 -> 0, 60 -> 6, 67 -> 7, 75 -> 8).
const byPercent = Array.from({ length: 101 }, (_, p) => ({ count: Math.ceil(p / 10), cumPct: p }));

describe('buildThresholdMarkers', () => {
  it('falls back to Conway defaults without params', () => {
    const r = buildThresholdMarkers(null);
    expect(r.markers.length).toBeGreaterThan(0);
    expect(r.thresholdsAsOf).toBeNull();
    expect(r.defaultThresholdPct).toBeGreaterThan(0);
  });

  it('groups synced thresholds sharing a percent under one marker', () => {
    // Constitution update and Protocol params (governance) both sit at 75% in
    // the extracted DEFAULT_DVT table, and 75 has no MARKER_SUMMARY collapse
    // (only 67 does), so this exercises the grouping without the summary text
    // masking it.
    const r = buildThresholdMarkers({
      dvtUpdateConstitution: 0.75,
      dvtPpGov: 0.75,
      syncedAt: 1735000000000,
    } as never);
    const at75 = r.markers.find((m) => m.pct === 75);
    expect(at75?.actions).toEqual(['Constitution update', 'Protocol params (governance)']);
    expect(r.thresholdsAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('collapses the busy 67% marker to its summary phrase, not the raw action list', () => {
    // No confidence and Hard fork both round to 67%, which is exactly the
    // threshold the MARKER_SUMMARY table collapses to one illustrative phrase,
    // so the grouped actions never reach the template as a raw two-item list.
    const r = buildThresholdMarkers({
      dvtMotionNoConfidence: 0.67,
      dvtHardFork: 0.67,
      syncedAt: 1735000000000,
    } as never);
    const at67 = r.markers.find((m) => m.pct === 67);
    expect(at67?.actions).toEqual(['Treasury withdrawal and some network parameters']);
  });
});

describe('buildCoalitionTable', () => {
  it('joins the grouped thresholds with the minimum coalition counts, full labels', () => {
    const rows = buildCoalitionTable(paramsFixture, byPercent);
    // paramsFixture thresholds: treasury 0.67, hard fork 0.6, constitution 0.75,
    // no confidence 0.67, committee normal 0.67, committee no-confidence 0.6,
    // pp network/economic/technical 0.67, pp governance 0.75.
    expect(rows.map((r) => r.pct)).toEqual([60, 67, 75]);
    expect(rows[0].count).toBe(6);
    expect(rows[1].count).toBe(7);
    expect(rows[2].count).toBe(8);
    // Full labels, NOT the island's collapsed summary.
    expect(rows[1].actions).toContain('Treasury withdrawal');
    expect(rows[1].actions).toContain('No confidence');
    expect(rows[1].actions.length).toBeGreaterThan(2);
  });

  it('falls back to the genesis defaults without synced params', () => {
    const rows = buildCoalitionTable(null, byPercent);
    expect(rows.map((r) => r.pct)).toEqual([60, 67, 75]);
  });

  it('returns no rows for an empty distribution', () => {
    const empty = Array.from({ length: 101 }, () => ({ count: 0, cumPct: 0 }));
    expect(buildCoalitionTable(paramsFixture, empty)).toEqual([]);
  });

  it('leaves buildThresholdMarkers output untouched including the 67 summary', () => {
    const { markers } = buildThresholdMarkers(paramsFixture);
    const m67 = markers.find((m) => m.pct === 67);
    expect(m67?.actions).toEqual(['Treasury withdrawal and some network parameters']);
  });
});
