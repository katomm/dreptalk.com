import { FIGURES } from './figures.js';
import { SPRITES } from './sprites.js';
import { SHAPES } from './shapes.js';
import type { ResolvedOptions } from './types.js';

/**
 * Map a hash-derived value into a parameter range using modulo.
 * Example: processParam(70, 100, 213) -> 70 + (213 % 30) = 73
 */
function processParam(min: number, max: number, value: number): number {
  return min + (value % (max - min));
}

/**
 * Render a hexagonal identicon as an SVG string.
 *
 * The hexagon is built from 28 triangles arranged in 4 columns (see sprites.ts).
 * Each triangle gets an HSL background fill, with optional figure overlay in a
 * shifted hue for the pattern effect. Hidden corner sprites are skipped, which
 * creates the hexagonal silhouette.
 *
 * Visual parameters are derived from hashValues (one byte per parameter):
 * - [0] hue, [1] saturation, [2] lightness, [3] shift, [4] figureAlpha,
 * - [5] figure pattern index, [6] per-triangle variation seed
 *
 * Lighting simulates a 3D cube effect by adjusting lightness per face
 * (top, left, right).
 */
export function renderSVG(hashValues: Uint16Array, options: ResolvedOptions): string {
  // Derive color parameters from hash bytes
  const hue = processParam(options.hue.min, options.hue.max, hashValues[0]);
  const saturation = processParam(options.saturation.min, options.saturation.max, hashValues[1]);
  const lightness = processParam(options.lightness.min, options.lightness.max, hashValues[2]);
  const shift = processParam(options.shift.min, options.shift.max, hashValues[3]);
  const figureAlpha = processParam(options.figureAlpha.min, options.figureAlpha.max, hashValues[4]);

  // Select one of 170 predefined figure patterns
  const figureIndex = hashValues[5] % FIGURES.length;

  const s = options.size;
  const parts: string[] = [];

  for (let i = 0; i < SPRITES.length; i++) {
    const sprite = SPRITES[i];
    if (sprite.hidden) continue;

    // 3D lighting: adjust lightness based on which face of the hexagon this triangle belongs to
    const light = options.light.enabled ? options.light[sprite.light!] : 0;

    // Per-triangle hue variation derived from hash, decreasing with sprite index
    const x = Math.round(hashValues[6] / (i + 1));
    const variation = options.variation.enabled
      ? processParam(options.variation.min, options.variation.max, x)
      : 0;

    // Calculate triangle vertices in pixel coordinates (shape coords are normalized 0-1)
    const shape = SHAPES[sprite.shape];
    const x1 = +(s * (shape.x1 + sprite.x)).toFixed(2);
    const y1 = +(s * (shape.y1 + sprite.y)).toFixed(2);
    const x2 = +(s * (shape.x2 + sprite.x)).toFixed(2);
    const y2 = +(s * (shape.y2 + sprite.y)).toFixed(2);
    const x3 = +(s * (shape.x3 + sprite.x)).toFixed(2);
    const y3 = +(s * (shape.y3 + sprite.y)).toFixed(2);

    const points = `${x1},${y1} ${x2},${y2} ${x3},${y3}`;
    const h = hue + variation;
    const l = lightness + light;

    // Base triangle fill
    parts.push(`<polygon points="${points}" fill="hsl(${h},${saturation}%,${l}%)"/>`);

    // Figure overlay: a second polygon with shifted hue and partial opacity,
    // creating the distinctive pattern on top of the base color.
    // Figure values are 0 (no overlay), 8, or 9 (intensity levels).
    const figure = FIGURES[figureIndex];
    if (figure[i] > 0) {
      const alpha = +(figure[i] * figureAlpha / 10).toFixed(2);
      parts.push(
        `<polygon points="${points}" fill="hsl(${h + shift},${saturation}%,${l}%)" opacity="${alpha}"/>`
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${parts.join('')}</svg>`;
}
