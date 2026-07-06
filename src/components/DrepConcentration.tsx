import { useMemo, useState } from 'react';
import type { Concentration } from '@/lib/dreps/concentration.js';
import { coalitionAt, snapThreshold, buildSegments, summarySentence, type DonutSegment } from '@/lib/dreps/concentrationView.js';
import { truncateId } from '@/lib/forum/view.js';
import { drepPath } from '@/lib/dreps/profile.js';

// A DRep voting threshold and the governance actions it gates. Several actions
// can share one threshold percent (they are grouped server-side).
export interface ThresholdMarker {
  pct: number; // e.g. 67
  actions: string[]; // e.g. ["Treasury withdrawal", "Hard fork"]
}

interface Props {
  topK: Concentration['topK'];
  byPercent: Concentration['byPercent'];
  drepCount: number;
  totalLabel: string;
  markers: ThresholdMarker[];
  defaultThresholdPct: number; // e.g. 67
  thresholdsAsOf: string | null; // formatted date or null
}

const SLIDER_MIN = 40;
const SLIDER_MAX = 90;
const R = 80; // donut radius in the 200x200 viewBox
const STROKE = 22;
const C = 2 * Math.PI * R;

// Decreasing-opacity accent shades for the individual top DRep slices.
function topTone(i: number): string {
  const op = Math.max(0.4, 1 - i * 0.06);
  return `color-mix(in srgb, var(--accent) ${Math.round(op * 100)}%, var(--surface))`;
}

function toneFor(kind: DonutSegment['kind'], index: number): string {
  if (kind === 'top') return topTone(index);
  if (kind === 'coalitionRest') return 'color-mix(in srgb, var(--accent) 30%, var(--surface))';
  return 'var(--border)';
}

export default function DrepConcentration(props: Props) {
  const { topK, byPercent, drepCount, totalLabel, markers, defaultThresholdPct, thresholdsAsOf } = props;
  const [threshold, setThreshold] = useState(defaultThresholdPct);

  const markersPct = markers.map((m) => m.pct);
  // The governance actions gated at the currently selected threshold, if it sits
  // exactly on a marker (the slider snaps to markers within a small tolerance).
  const currentMarker = markers.find((m) => m.pct === threshold);

  // coalitionAt is a plain indexed lookup, so it is not worth memoizing; only the
  // allocating buildSegments is.
  const coalition = coalitionAt(byPercent, threshold);
  const segments = useMemo(() => buildSegments(topK, coalition), [topK, coalition]);

  // Cumulative start offset per drawn arc (the muted remainder is skipped; the
  // background track circle shows through instead).
  let start = 0;
  let topIdx = 0;
  const arcs = segments
    .filter((s) => s.kind !== 'remainder')
    .map((s) => {
      const dash = (s.pct / 100) * C;
      const offset = -(start / 100) * C;
      start += s.pct;
      const tone = toneFor(s.kind, topIdx);
      // Stable key: a top slice keys off its DRep id, the lone coalition-rest
      // slice off its kind. No array index, so reordering never mis-reconciles.
      const key = s.kind === 'top' ? topK[topIdx].drepId : s.kind;
      if (s.kind === 'top') topIdx++;
      return { dash, offset, tone, key };
    });

  // Threshold tick: a short radial line at the selected percent (top is 0%).
  const tickRad = ((threshold / 100) * 360 - 90) * (Math.PI / 180);
  const inner = R - STROKE / 2 - 3;
  const outer = R + STROKE / 2 + 3;
  const tx1 = 100 + inner * Math.cos(tickRad);
  const ty1 = 100 + inner * Math.sin(tickRad);
  const tx2 = 100 + outer * Math.cos(tickRad);
  const ty2 = 100 + outer * Math.sin(tickRad);

  return (
    <section id="concentration" className="drep-conc" aria-labelledby="drep-conc-title">
      <h2 id="drep-conc-title" className="drep-conc__title">Voting power concentration</h2>
      <p className="drep-conc__summary">
        {summarySentence(coalition.count, threshold)}. Total {totalLabel} across {drepCount.toLocaleString('en-US')} DReps.
      </p>

      <div className="drep-conc__body">
        {/* Left column: the donut, the threshold slider, and the as-of note. */}
        <div className="drep-conc__main">
          <div className="drep-conc__chart">
            <svg viewBox="0 0 200 200" width="200" height="200" aria-hidden="true">
              <circle cx="100" cy="100" r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} opacity="0.5" />
              <g transform="rotate(-90 100 100)">
                {arcs.map((a) => (
                  <circle
                    key={a.key}
                    cx="100"
                    cy="100"
                    r={R}
                    fill="none"
                    stroke={a.tone}
                    strokeWidth={STROKE}
                    strokeDasharray={`${a.dash} ${C - a.dash}`}
                    strokeDashoffset={a.offset}
                  />
                ))}
              </g>
              <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} stroke="var(--fg)" strokeWidth="2" />
            </svg>
            <div className="drep-conc__center">
              <span className="drep-conc__count">{coalition.count.toLocaleString('en-US')}</span>
              <span className="drep-conc__count-label">DReps = {threshold}%</span>
            </div>
          </div>

          <div className="drep-conc__controls">
            <label htmlFor="drep-conc-slider" className="drep-conc__slider-label">Threshold: {threshold}%</label>
            <input
              id="drep-conc-slider"
              type="range"
              min={SLIDER_MIN}
              max={SLIDER_MAX}
              step={1}
              value={threshold}
              list="drep-conc-markers"
              onChange={(e) => setThreshold(snapThreshold(Number(e.target.value), markersPct))}
            />
            <datalist id="drep-conc-markers">
              {markersPct.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <div className="drep-conc__markers">
              {markers.map((mk) => (
                <button
                  key={mk.pct}
                  type="button"
                  className="drep-conc__marker"
                  aria-pressed={threshold === mk.pct}
                  onClick={() => setThreshold(mk.pct)}
                  title={mk.actions.length ? mk.actions.join(', ') : undefined}
                >
                  {mk.pct}%
                </button>
              ))}
            </div>

            {/* Always rendered with a reserved height (see CSS) so dragging the
                slider on or off a marker never changes this column's height, which
                would otherwise reflow the donut and re-center the legend. */}
            <p className="drep-conc__threshold-actions">
              {currentMarker && currentMarker.actions.length > 0
                ? `${threshold}% is the passing threshold for ${currentMarker.actions.join(', ')}.`
                : 'Move onto a marker to see the actions it gates.'}
            </p>
          </div>

          {thresholdsAsOf && <p className="drep-conc__asof">Thresholds as of {thresholdsAsOf}.</p>}
        </div>

        {/* Right column: the top DReps by share. Hidden on narrow screens. The
            caption makes clear this is a fixed top-N list, not the coalition
            count shown in the donut center (which grows with the threshold). */}
        <div className="drep-conc__legend-col">
          <p className="drep-conc__legend-caption">Top {topK.length} by share</p>
          <ol className="drep-conc__legend">
            {topK.map((t, i) => (
              <li key={t.drepId} className="drep-conc__legend-item">
                <span className="drep-conc__swatch" style={{ background: topTone(i) }} aria-hidden="true" />
                <a href={drepPath(t)} className="drep-conc__legend-name">{t.name ?? truncateId(t.drepId)}</a>
                <span className="drep-conc__legend-pct">{t.pct.toFixed(1)}%</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
