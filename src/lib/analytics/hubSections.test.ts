import { describe, expect, it } from 'vitest';
import { HUB_SECTION_IDS, hubJumpLinks } from './hubSections.js';

const ids = (hasRationale: boolean, hasThroughput: boolean) => hubJumpLinks({ hasRationale, hasThroughput }).map((l) => l.id);

describe('hubJumpLinks', () => {
  it('points the rationale question at its panel, or at the chapter head while the panel has no data', () => {
    expect(ids(true, false)).toContain(HUB_SECTION_IDS.rationale);
    expect(ids(false, false)).toContain(HUB_SECTION_IDS.accountability);
    expect(ids(false, false)).not.toContain(HUB_SECTION_IDS.rationale);
  });

  it('lists throughput only when it has data', () => {
    expect(ids(true, true)).toContain(HUB_SECTION_IDS.throughput);
    expect(ids(true, false)).not.toContain(HUB_SECTION_IDS.throughput);
  });
});
