// Heading ids of the /analytics hub, the one place they are defined. The page
// stamps them on its HeadingAnchor headings and section labels, every deep link
// (homepage strip, DReps directory, guides) builds its href from here, so a
// renamed section cannot silently strand a link at the top of the page.
export const HUB_SECTION_IDS = {
  today: 'chapter-today-title',
  defaults: 'hub-defaults-title',
  trends: 'hub-trends-title',
  representation: 'chapter-representation-title',
  effrep: 'hub-effrep-title',
  activity: 'hub-activity-title',
  cc: 'hub-cc-title',
  spo: 'hub-spo-title',
  accountability: 'chapter-accountability-title',
  votechange: 'hub-votechange-title',
  rationale: 'hub-rationale-title',
  timing: 'hub-timing-title',
  decentralization: 'chapter-decentralization-title',
  coalition: 'hub-coalition-title',
  concTrends: 'hub-conc-trends-title',
  throughput: 'chapter-throughput-title',
} as const;

export type HubSection = keyof typeof HUB_SECTION_IDS;

/** Absolute href that opens the hub scrolled to one section. */
export function hubHref(section: HubSection): string {
  return `/analytics/#${HUB_SECTION_IDS[section]}`;
}
