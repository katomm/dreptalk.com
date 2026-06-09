import type { Triangle } from './types.js';

/**
 * The two triangle shapes used to tile the hexagon.
 * Coordinates are in normalized [0,1] space, the renderer scales them to pixel size.
 *
 * Shape 0: left-pointing triangle (wider, used for fills)
 * Shape 1: right-pointing triangle (narrower, used for edges)
 *
 * Each sprite in sprites.ts references one of these shapes by index
 * and applies an (x, y) offset to position it within the hexagon grid.
 */
export const SHAPES: Triangle[] = [
  { x1: 0, y1: 0.25, x2: 0.25, y2: 0.125, x3: 0.25, y3: 0.375 },
  { x1: 0, y1: 0, x2: 0.25, y2: 0.125, x3: 0, y3: 0.25 },
];
