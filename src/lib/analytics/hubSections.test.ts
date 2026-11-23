import { describe, expect, it } from 'vitest';
import { HUB_SECTION_IDS, hubJumpLinks } from './hubSections.js';

describe('hubJumpLinks', () => {
  it('links the rationale question to its panel and lists throughput when both have data', () => {
    const links = hubJumpLinks({ hasRationale: true, hasThroughput: true });
    expect(links).toHaveLength(5);
    expect(links[2].id).toBe(HUB_SECTION_IDS.rationale);
    expect(links.at(-1)?.id).toBe(HUB_SECTION_IDS.throughput);
  });

  it('falls back to the accountability chapter and drops throughput without data', () => {
    const links = hubJumpLinks({ hasRationale: false, hasThroughput: false });
    expect(links).toHaveLength(4);
    expect(links[2].id).toBe(HUB_SECTION_IDS.accountability);
    expect(links.map((l) => l.id)).not.toContain(HUB_SECTION_IDS.throughput);
  });
});
