// Sparkline geometry for the OG cards. Pure: turns a series of non-negative
// values into SVG path data on a ZERO baseline, so growth reads as growth and a
// flat series reads flat (a padded minimum would exaggerate small moves on a
// card that cannot carry an axis). Null when there is nothing worth drawing:
// fewer than two points or no positive value.
export interface SparklinePaths {
  /** Open polyline through every point, oldest on the left. */
  line: string;
  /** The same polyline closed down to the baseline for a filled area. */
  area: string;
  /** Last point, for an end marker. */
  end: { x: number; y: number };
}

export function sparklinePaths(values: number[], width: number, height: number, topPad = 6): SparklinePaths | null {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  if (!(max > 0)) return null;
  const innerH = height - topPad;
  const stepX = width / (values.length - 1);
  const pts = values.map((v, i) => ({
    x: Math.round(i * stepX * 10) / 10,
    y: Math.round((topPad + innerH - (Math.max(0, v) / max) * innerH) * 10) / 10,
  }));
  const line = `M${pts.map((p) => `${p.x},${p.y}`).join(' L')}`;
  const area = `${line} L${width},${height} L0,${height} Z`;
  return { line, area, end: pts[pts.length - 1] };
}
