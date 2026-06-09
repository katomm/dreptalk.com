import type { Sprite } from './types.js';

/**
 * The 28 triangle positions that compose the hexagonal icon.
 *
 * Arranged in 4 columns (x: 0, 0.25, 0.5, 0.75), each containing 7 triangles.
 * Corner triangles are marked `hidden: true`, skipping them creates the
 * hexagonal silhouette instead of a rectangle.
 *
 * Each sprite's `light` property assigns it to a face of the simulated 3D cube
 * (top, left, right), which the renderer uses to adjust lightness for depth.
 */
export const SPRITES: Sprite[] = [
  // Column 1 (x=0), left edge
  { x: 0, y: 0, shape: 1, hidden: true },       // top-left corner (hidden)
  { x: 0, y: 0, shape: 0, light: 'top' },
  { x: 0, y: 0.25, shape: 1, light: 'left' },
  { x: 0, y: 0.25, shape: 0, light: 'left' },
  { x: 0, y: 0.5, shape: 1, light: 'left' },
  { x: 0, y: 0.5, shape: 0, light: 'left' },
  { x: 0, y: 0.75, shape: 1, hidden: true },     // bottom-left corner (hidden)

  // Column 2 (x=0.25), center-left
  { x: 0.25, y: -0.125, shape: 0, light: 'top' },
  { x: 0.25, y: 0.125, shape: 1, light: 'top' },
  { x: 0.25, y: 0.125, shape: 0, light: 'top' },
  { x: 0.25, y: 0.375, shape: 1, light: 'left' },
  { x: 0.25, y: 0.375, shape: 0, light: 'left' },
  { x: 0.25, y: 0.625, shape: 1, light: 'left' },
  { x: 0.25, y: 0.625, shape: 0, light: 'left' },

  // Column 3 (x=0.5), center-right
  { x: 0.5, y: 0, shape: 1, light: 'top' },
  { x: 0.5, y: 0, shape: 0, light: 'top' },
  { x: 0.5, y: 0.25, shape: 1, light: 'top' },
  { x: 0.5, y: 0.25, shape: 0, light: 'right' },
  { x: 0.5, y: 0.5, shape: 1, light: 'right' },
  { x: 0.5, y: 0.5, shape: 0, light: 'right' },
  { x: 0.5, y: 0.75, shape: 1, light: 'right' },

  // Column 4 (x=0.75), right edge
  { x: 0.75, y: -0.125, shape: 0, hidden: true }, // top-right corner (hidden)
  { x: 0.75, y: 0.125, shape: 1, light: 'top' },
  { x: 0.75, y: 0.125, shape: 0, light: 'right' },
  { x: 0.75, y: 0.375, shape: 1, light: 'right' },
  { x: 0.75, y: 0.375, shape: 0, light: 'right' },
  { x: 0.75, y: 0.625, shape: 1, light: 'right' },
  { x: 0.75, y: 0.625, shape: 0, hidden: true },  // bottom-right corner (hidden)
];
