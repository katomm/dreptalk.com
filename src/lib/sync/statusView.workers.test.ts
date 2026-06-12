import { describe, it, expect } from 'vitest';
import { formatBerlinDateTime, berlinDayKey } from './statusView.js';

// The status page renders these server-side in the Workers runtime, so confirm
// workerd ships the ICU time-zone data the Node tests rely on. Without it, Intl
// would silently fall back to UTC and the page would mislabel every timestamp.
describe('Berlin formatting under the Workers runtime', () => {
  it('applies the Europe/Berlin zone and DST in workerd', () => {
    const summer = Date.UTC(2026, 5, 13, 0, 14, 30); // -> 02:14 CEST, 13 Jun
    expect(formatBerlinDateTime(summer)).toBe('13.06.2026, 02:14 MESZ');
    expect(berlinDayKey(Date.UTC(2026, 0, 15, 23, 5, 0))).toBe('2026-01-16'); // past midnight CET
  });
});
