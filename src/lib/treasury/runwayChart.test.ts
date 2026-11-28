import { describe, it, expect } from 'vitest';
import { runwayChart, RUNWAY_CHART } from './runwayChart.js';

const inp = { lastClosedEpoch: 670, epochStartSec: Date.UTC(2026, 10, 25) / 1000, epochLengthSec: 432000 };
const B = 1_000_000_000_000_000n;

describe('runwayChart', () => {
  it('draws history solid and projection dashed in one domain', () => {
    const c = runwayChart(
      inp,
      [
        { epoch: 600, treasury: 2n * B },
        { epoch: 670, treasury: 1n * B },
      ],
      [
        { epoch: 670, treasury: 1n * B },
        { epoch: 743, treasury: 0n },
      ],
    );
    expect(c.historyPath.startsWith('M')).toBe(true);
    expect(c.projectionPath.startsWith('M')).toBe(true);
    // The projection starts where the history ends.
    expect(c.projectionPath.split(' ')[0].slice(1)).toBe(c.historyPath.split(' ').at(-1)?.slice(1));
    expect(c.yTicks.at(-1)?.label).toBe('2.0B');
    expect(c.xTicks.length).toBeGreaterThan(3);
    expect(c.xTicks.every((t) => t.x >= RUNWAY_CHART.left && t.x <= RUNWAY_CHART.width - RUNWAY_CHART.right)).toBe(true);
  });

  it('clips projection points above the history maximum', () => {
    const c = runwayChart(inp, [{ epoch: 670, treasury: B }], [{ epoch: 670, treasury: B }, { epoch: 743, treasury: 10n * B }]);
    const ys = c.projectionPath.split(' ').map((p) => Number(p.slice(1).split(',')[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(RUNWAY_CHART.top);
  });

  it('returns empty paths without history', () => {
    expect(runwayChart(inp, [], []).historyPath).toBe('');
  });
});
