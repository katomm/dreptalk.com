/** A numeric min/max range for constraining hash-derived visual parameters. */
export interface Range {
  min: number;
  max: number;
}

/** The three faces of the simulated 3D hexagon, each with a different lightness offset. */
export type Light = 'top' | 'left' | 'right';

/** User-facing options for customizing identicon appearance. */
export interface CardenticonOptions {
  /** Icon size in pixels (default: 100) */
  size?: number;
  /** Hue range 0-360 (default: 0-360) */
  hue?: Range;
  /** Saturation range 0-100 (default: 70-100) */
  saturation?: Range;
  /** Lightness range 0-100 (default: 45-65) */
  lightness?: Range;
  /** Per-triangle hue variation (default: 5-20, enabled) */
  variation?: Range & { enabled?: boolean };
  /** Hue shift between base color and figure overlay (default: 60-300) */
  shift?: Range;
  /** Opacity multiplier for the figure overlay pattern (default: 0.7-1.2) */
  figureAlpha?: Range;
  /** 3D lighting offsets per face, positive = brighter (default: top +10, right -8, left -4) */
  light?: Record<Light, number> & { enabled?: boolean };
}

/** Fully resolved options with no optional fields (internal use). */
export interface ResolvedOptions {
  size: number;
  hue: Range;
  saturation: Range;
  lightness: Range;
  variation: Range & { enabled: boolean };
  shift: Range;
  figureAlpha: Range;
  light: Record<Light, number> & { enabled: boolean };
}

/** A triangle defined by three vertices in normalized [0,1] coordinate space. */
export interface Triangle {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
}

/** A positioned triangle within the hexagon grid. */
export interface Sprite {
  /** Column offset (0, 0.25, 0.5, 0.75) */
  x: number;
  /** Row offset within the column */
  y: number;
  /** Which triangle shape to use (0 = left-pointing, 1 = right-pointing) */
  shape: 0 | 1;
  /** If true, this triangle is not rendered (creates the hexagonal silhouette) */
  hidden?: boolean;
  /** Which 3D face this triangle belongs to (determines lightness adjustment) */
  light?: Light;
}
