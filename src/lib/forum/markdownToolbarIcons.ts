// Lucide icon path data (24x24 stroke grid) for the Markdown toolbar buttons,
// matching the inline-SVG, no-dependency convention in ./icons.ts. Each value is
// a single combined `d` string rendered as one <path stroke="currentColor"> with
// round caps, so multi-part glyphs (italic strokes, the list dots, the at-sign
// ring) collapse into one path while looking identical to the source icons.

import type { MarkdownAction } from './markdownToolbar.js';

export const TOOLBAR_ICON: Record<MarkdownAction | 'mention', string> = {
  bold: 'M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8',
  italic: 'M19 4 10 4M14 20 5 20M15 4 9 20',
  strike: 'M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12H20',
  heading: 'M6 12h12M6 20V4M18 20V4',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  quote:
    'M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2zM5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z',
  list: 'M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13',
  orderedList: 'M11 5h10M11 12h10M11 19h10M4 4h1v5M4 9h2M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  mention: 'M16 12a4 4 0 1 1-8 0 4 4 0 1 1 8 0M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8',
};
