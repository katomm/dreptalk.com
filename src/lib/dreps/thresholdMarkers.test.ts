import { describe, it, expect } from 'vitest';
import { buildThresholdMarkers } from './thresholdMarkers.js';

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
