// Generates tier and locked variants of the badge artwork in public/badges/.
//
// The base SVGs are hand-authored, self-contained files. A variant is a full
// recolor (Duolingo-style): every non-white color is ranked by luminance and
// mapped onto a tier ramp, so the glyph and depth shading survive while the
// whole badge changes color family. #ffffff is preserved. Element ids get a
// tier suffix so a base badge and its variant can be inlined on one page.
//
// Tiered badges get -bronze/-silver/-gold, every visible badge gets -locked.
// Hidden badges get no variants (the mystery card stands in until earned).
// Output is deterministic and committed; re-run after changing base artwork:
//   node scripts/generate-badge-variants.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Node 22.18+ strips types natively, so the catalog is imported directly.
import { BADGES } from '../config/badges.ts';

const BADGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'badges');

// Dark-to-light ramps, 7 stops each. Locked mirrors the hand-tuned desaturated
// look of the original shows-the-work-locked.svg.
const RAMPS = {
  bronze: ['#451a03', '#6b3410', '#8f4f1d', '#b06f33', '#cd8f52', '#e3b483', '#f3d9b9'],
  silver: ['#1f242c', '#3a424e', '#596472', '#7d8898', '#a3adbb', '#c8cfd9', '#e9edf2'],
  gold: ['#412402', '#633806', '#92580b', '#c17d14', '#dfa128', '#efc55c', '#f8e3a8'],
  locked: ['#8f8b9e', '#9d99ad', '#b6b3c2', '#c6c3d1', '#d6d3e0', '#e4e2ec', '#f1eff6'],
};

function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff);
}

function recolor(svg, ramp, suffix) {
  const colors = [...new Set((svg.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((c) => c.toLowerCase()))]
    .filter((c) => c !== '#ffffff')
    .sort((a, b) => luminance(a) - luminance(b));
  let out = svg;
  for (const [i, color] of colors.entries()) {
    const stop = ramp[colors.length === 1 ? 3 : Math.round((i * (ramp.length - 1)) / (colors.length - 1))];
    out = out.replaceAll(new RegExp(color, 'gi'), stop);
  }
  // Suffix ids and their references so base and variant can share a document.
  out = out.replaceAll(/id="([\w-]+)"/g, `id="$1-${suffix}"`);
  out = out.replaceAll(/url\(#([\w-]+)\)/g, `url(#$1-${suffix})`);
  return out.replace('<svg', `<!-- generated from the base badge by scripts/generate-badge-variants.mjs -->\n<svg`);
}

let written = 0;
for (const badge of BADGES) {
  if (badge.hidden) continue;
  const base = readFileSync(join(BADGE_DIR, `${badge.id}.svg`), 'utf8');
  const variants = badge.tiers ? ['bronze', 'silver', 'gold', 'locked'] : ['locked'];
  for (const tier of variants) {
    writeFileSync(join(BADGE_DIR, `${badge.id}-${tier}.svg`), recolor(base, RAMPS[tier], tier[0]));
    written++;
  }
}
console.log(`generated ${written} variant SVGs in public/badges/`);
