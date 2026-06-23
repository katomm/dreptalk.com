// Color and size tokens for the dynamic Open Graph cards. Mirrors the per-type
// accent colors from src/styles/global.css (light theme only: an OG image is one
// fixed bitmap and cannot follow the viewer's dark mode) and the designer spec
// sheet. Kept dependency-free so the pure model layer can import it.

import { govTypeTone } from '../governance/view.js';
import type { StatusTone } from '../governance/view.js';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// Brand and neutral ink. Brand accent matches --accent in global.css; the
// designer's neutral ramp (N-900 ink, N-500 muted) coincides with our values.
export const BRAND_ACCENT = '#6d28d9';
export const INK = '#14101c';
export const MUTED = '#5f6672';
export const SUBTLE = '#9aa0aa';
export const HAIRLINE = '#e3e6eb';
export const TRACK = '#e6e8ec';
export const CARD_BG = '#ffffff';

// Per governance-type accent, only this and the type pill change between action
// cards (the "accent colour only" differentiation). Values are the light-theme
// --gov-* tokens from global.css.
const TYPE_ACCENT: Record<string, string> = {
  constitution: '#7c3aed',
  treasury: '#15692e',
  parameter: '#2563c9',
  info: '#5b54d6',
  hardfork: '#b45309',
  committee: '#0f766e',
  noconfidence: '#b1281c',
  other: BRAND_ACCENT,
};

export function accentForType(type: string): string {
  return TYPE_ACCENT[govTypeTone(type)] ?? BRAND_ACCENT;
}

// Saturated tally colours from the designer spec. Deliberately stronger than the
// in-app bar so the three segments stay legible at thumbnail size.
export const TALLY = {
  yes: '#16a34a',
  no: '#dc2626',
  abstain: '#6b7280',
} as const;

// Status badge colour per tone. 'active' uses the brand accent (not the spec's
// stray #7c3aed) so the badge matches the rest of the site.
const STATUS_COLOR: Record<StatusTone, string> = {
  active: BRAND_ACCENT,
  positive: '#16a34a',
  negative: '#dc2626',
  neutral: '#6b7280',
};

export function statusColor(tone: StatusTone): string {
  return STATUS_COLOR[tone];
}

// A 12%-opacity tint of a solid hex, for pill/badge backgrounds. Appends the
// alpha byte (0x1f ~= 12%); satori parses 8-digit hex colours.
export function tint(hex: string): string {
  return `${hex}1f`;
}
