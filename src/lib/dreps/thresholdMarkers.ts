// Donut slider markers for the /dreps concentration chart: each DRep voting
// threshold (dvt_* fraction) paired with the governance action it gates,
// grouped by rounded percent. Pure extraction from src/pages/dreps/index.astro,
// moved here verbatim so the hub view model (Task 4/5) can reuse it. No DB
// access, the caller fetches ProtocolParams and passes it in.
import type { ProtocolParams } from '../db/protocolParams.js';
import type { ThresholdMarker } from '../../components/DrepConcentration.tsx';

export interface ThresholdMarkersResult {
  markers: ThresholdMarker[];
  defaultThresholdPct: number;
  thresholdsAsOf: string | null;
}

/**
 * Threshold markers for the donut slider, plus the default marker to preselect
 * and the date the synced thresholds are as of. Canonical Conway genesis
 * defaults label the markers before the protocol params have synced, synced
 * params override them when present.
 */
export function buildThresholdMarkers(params: ProtocolParams | null): ThresholdMarkersResult {
  const DEFAULT_DVT: { fraction: number; label: string }[] = [
    { fraction: 0.67, label: 'No confidence' },
    { fraction: 0.67, label: 'Committee (normal state)' },
    { fraction: 0.6, label: 'Committee (no confidence)' },
    { fraction: 0.75, label: 'Constitution update' },
    { fraction: 0.6, label: 'Hard fork' },
    { fraction: 0.67, label: 'Protocol params (network)' },
    { fraction: 0.67, label: 'Protocol params (economic)' },
    { fraction: 0.67, label: 'Protocol params (technical)' },
    { fraction: 0.75, label: 'Protocol params (governance)' },
    { fraction: 0.67, label: 'Treasury withdrawal' },
  ];
  const syncedDvt: { value: number | null; label: string }[] = params
    ? [
        { value: params.dvtTreasuryWithdrawal, label: 'Treasury withdrawal' },
        { value: params.dvtHardFork, label: 'Hard fork' },
        { value: params.dvtUpdateConstitution, label: 'Constitution update' },
        { value: params.dvtMotionNoConfidence, label: 'No confidence' },
        { value: params.dvtCommitteeNormal, label: 'Committee (normal state)' },
        { value: params.dvtCommitteeNoConfidence, label: 'Committee (no confidence)' },
        { value: params.dvtPpNetwork, label: 'Protocol params (network)' },
        { value: params.dvtPpEconomic, label: 'Protocol params (economic)' },
        { value: params.dvtPpTechnical, label: 'Protocol params (technical)' },
        { value: params.dvtPpGov, label: 'Protocol params (governance)' },
      ]
    : [];
  const dvtSource = syncedDvt.some((d) => typeof d.value === 'number' && d.value > 0)
    ? syncedDvt
    : DEFAULT_DVT.map((d) => ({ value: d.fraction, label: d.label }));
  const actionsByPct = new Map<number, string[]>();
  for (const { value, label } of dvtSource) {
    if (typeof value === 'number' && value > 0) {
      const pct = Math.round(value * 100);
      const list = actionsByPct.get(pct);
      if (list) list.push(label);
      else actionsByPct.set(pct, [label]);
    }
  }
  // The raw grouped list is exhaustive (67% alone gates six action types), which
  // reads as a wall of text in the marker hint. Collapse the busy thresholds to a
  // short, illustrative phrase, others fall through to their grouped labels.
  const MARKER_SUMMARY: Record<number, string> = {
    67: 'Treasury withdrawal and some network parameters',
  };
  const markers = [...actionsByPct.entries()].sort((a, b) => a[0] - b[0]).map(([pct, actions]) => {
    const summary = MARKER_SUMMARY[pct];
    return { pct, actions: summary ? [summary] : actions };
  });
  const markersPct = markers.map((m) => m.pct);
  const defaultThresholdPct = markersPct.includes(67) ? 67 : (markersPct[Math.floor(markersPct.length / 2)] ?? 67);
  const thresholdsAsOf = params ? new Date(params.syncedAt).toISOString().slice(0, 10) : null;

  return { markers, defaultThresholdPct, thresholdsAsOf };
}
