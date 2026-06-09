// Vendored from https://github.com/adatainment/cardenticon @ 6970eab (Apache-2.0).
// Changes from upstream: relative import specifiers carry the .js extension for
// this repo's NodeNext module resolution; typographic dashes, right arrows, and
// the >= Unicode char in comments replaced with ASCII equivalents per this repo's
// comment style. See LICENSE and NOTICE in this folder.
import { isCardanoAddress, decodeBech32 } from './bech32.js';
import { hashString, hexToBytes, isHex } from './hash.js';
import { renderSVG } from './renderer.js';
import type { CardenticonOptions, ResolvedOptions } from './types.js';

export type { CardenticonOptions, Range, Light } from './types.js';

/** Default visual parameters, matching the hashicon aesthetic. */
const DEFAULTS: ResolvedOptions = {
  size: 100,
  hue: { min: 0, max: 360 },
  saturation: { min: 70, max: 100 },
  lightness: { min: 45, max: 65 },
  variation: { min: 5, max: 20, enabled: true },
  shift: { min: 60, max: 300 },
  figureAlpha: { min: 0.7, max: 1.2 },
  light: { top: 10, right: -8, left: -4, enabled: true },
};

/**
 * Convert an input string to raw bytes for the renderer.
 *
 * Resolution order:
 * 1. Cardano bech32 address: decode and use credential hashes directly
 *    (skips the 1-byte header which only encodes address type + network)
 * 2. Hex string (>=14 chars): parse as raw bytes
 * 3. Anything else: hash with cyrb128 to produce 16 deterministic bytes
 */
function resolveBytes(input: string): Uint8Array {
  if (isCardanoAddress(input)) {
    const payload = decodeBech32(input);
    return payload.slice(1);
  }
  if (isHex(input)) {
    return hexToBytes(input);
  }
  return hashString(input);
}

function mergeOptions(options?: Partial<CardenticonOptions>): ResolvedOptions {
  if (!options) return DEFAULTS;
  return {
    size: options.size ?? DEFAULTS.size,
    hue: options.hue ?? DEFAULTS.hue,
    saturation: options.saturation ?? DEFAULTS.saturation,
    lightness: options.lightness ?? DEFAULTS.lightness,
    variation: { ...DEFAULTS.variation, ...options.variation },
    shift: options.shift ?? DEFAULTS.shift,
    figureAlpha: options.figureAlpha ?? DEFAULTS.figureAlpha,
    light: { ...DEFAULTS.light, ...options.light },
  };
}

/**
 * Generate a deterministic hexagonal SVG identicon.
 *
 * Accepts Cardano bech32 addresses (addr1..., stake1..., addr_test1..., stake_test1...),
 * hex strings, or arbitrary strings (hashed internally via cyrb128).
 *
 * The icon is a hexagon composed of 28 triangles in 4 columns. Visual parameters
 * (hue, saturation, lightness, pattern) are derived deterministically from the
 * input bytes, so the same input always produces the same icon.
 *
 * @param input - Cardano address, hex string, or any string
 * @param options - Visual customization (size, color ranges, lighting)
 * @returns SVG markup as a string
 */
export function cardenticon(input: string, options?: Partial<CardenticonOptions>): string {
  const bytes = resolveBytes(input);
  // Each byte (0-255) becomes one Uint16 element, used as seeds for visual parameters
  const hashValues = new Uint16Array(bytes);
  const opts = mergeOptions(options);
  return renderSVG(hashValues, opts);
}

/**
 * Generate an identicon as a base64-encoded data URL.
 * Useful for `<img src="...">` attributes where inline SVG isn't an option.
 */
export function cardenticonDataURL(input: string, options?: Partial<CardenticonOptions>): string {
  const svg = cardenticon(input, options);
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
