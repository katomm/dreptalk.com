import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BURST_CENTER, BURST_NODES, BURST_RING, BURST_SPOKES, burstLoaderSvg } from './burstMark';

const logo = readFileSync(new URL('../../../public/logo.svg', import.meta.url), 'utf8');

describe('burst mark geometry', () => {
  it('matches the canonical public/logo.svg', () => {
    for (const s of BURST_SPOKES) {
      expect(logo).toContain(`<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}"/>`);
    }
    for (const d of [...BURST_NODES, ...BURST_RING, BURST_CENTER]) {
      expect(logo).toContain(`<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}"`);
    }
  });
});

describe('burstLoaderSvg', () => {
  it('marks the eight nodes for the loader animation and leaves out the outer ring', () => {
    const svg = burstLoaderSvg(20);
    expect(svg.match(/class="burst-node"/g)).toHaveLength(8);
    expect(svg.match(/<circle/g)).toHaveLength(9);
    expect(svg).toContain('class="burst-loader" width="20" height="20"');
  });
});
