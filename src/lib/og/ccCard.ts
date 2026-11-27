// Open Graph card models for the Constitutional Committee pages: one card for the
// /cc/ overview (key figures over a small seat timeline) and one per member
// profile (the DRep card layout with the member's record). Shared by the /og/cc
// routes (render them) and the pages (version their og:image URL), so the URL
// changes whenever the card would.
import { tenureLabel } from '../analytics/ccPanelView.js';
import { truncateIdMiddle } from '../forum/view.js';
import { barSegments, timelineSpan, type CcFacts, type CcTimeline } from '../governance/ccOverview.js';
import type { CcMemberProfileView, CcStanding } from '../governance/ccProfile.js';
import type { DrepCardModel } from './model.js';
import { BRAND_ACCENT } from './theme.js';
import { ogCardVersion } from './version.js';

export interface CcMemberCardInput {
  coldKeyHex: string;
  name: string | null;
  standing: CcStanding | null;
  tenure: { from: number; to: number | null };
  voted: number;
  eligible: number;
  counts: { yes: number; no: number; abstain: number };
  readable: number;
}

/** The card fields of a loaded profile, shared by the page (version) and the route (render). */
export function ccMemberCardInput(profile: CcMemberProfileView, readable: number): CcMemberCardInput {
  const { coldKeyHex, name, standing, tenure, voted, eligible, counts } = profile;
  return { coldKeyHex, name, standing, tenure, voted, eligible, counts, readable };
}

export function ccMemberCardVersion(m: CcMemberCardInput): string {
  return ogCardVersion([
    'cc',
    m.name ?? '',
    m.standing ?? '',
    m.tenure.from,
    m.tenure.to ?? '',
    m.voted,
    m.eligible,
    m.counts.yes,
    m.counts.no,
    m.counts.abstain,
    m.readable,
  ]);
}

export function ccMemberCardModel(m: CcMemberCardInput, opts: { avatarDataUrl: string }): DrepCardModel {
  const idShort = truncateIdMiddle(m.coldKeyHex);
  const name = m.name?.trim();
  return {
    accent: BRAND_ACCENT,
    name: name ?? idShort,
    idShort: name ? idShort : null,
    handle: null,
    bio: m.voted > 0 ? `Yes ${m.counts.yes}, No ${m.counts.no}, Abstain ${m.counts.abstain}` : null,
    avatarDataUrl: opts.avatarDataUrl,
    stats: [
      { value: m.eligible > 0 ? `${m.voted} of ${m.eligible}` : 'None yet', label: 'actions voted on', icon: 'votes' },
      ...(m.voted > 0 ? [{ value: `${m.readable} of ${m.voted}`, label: 'votes with a rationale', icon: 'participation' as const }] : []),
      { value: m.standing ?? 'Member', label: tenureLabel(m.tenure), icon: 'epoch' },
    ],
  };
}

/** Width of the timeline on the card, the content width inside the card padding. */
export const CC_CARD_TIMELINE_WIDTH = 1104;
/** Height the bars may take on the card, gaps included. */
const CC_CARD_TIMELINE_HEIGHT = 250;
const ROW_GAP = 5;

export interface CcOverviewCardBar {
  /** Pixel offsets and widths on the card timeline. */
  offset: number;
  served: number;
  rest: number;
  active: boolean;
}

export interface CcOverviewCardModel {
  accent: string;
  title: string;
  subtitle: string;
  bars: CcOverviewCardBar[];
  rowHeight: number;
  rowGap: number;
  nowX: number | null;
}

/** Pixel offset and width of an inclusive epoch range on the card timeline. */
function pxSpan(t: CcTimeline, r: [number, number] | null): { left: number; width: number } {
  if (!r) return { left: 0, width: 0 };
  const { left, width } = timelineSpan(t, r[0], r[1]);
  return { left: Math.round((left / 100) * CC_CARD_TIMELINE_WIDTH), width: Math.round((width / 100) * CC_CARD_TIMELINE_WIDTH) };
}

export function ccOverviewCardModel(facts: CcFacts, timeline: CcTimeline | null): CcOverviewCardModel {
  const parts = [`${facts.activeSeats} active seats`];
  if (facts.thresholdPct != null) parts.push(`${Math.round(facts.thresholdPct * 10) / 10}% Yes needed`);
  if (facts.nextTermEnd) parts.push(`next term ends in epoch ${facts.nextTermEnd.epoch}`);
  const n = timeline?.bars.length ?? 0;
  const rowHeight = n > 0 ? Math.max(4, Math.min(14, Math.floor((CC_CARD_TIMELINE_HEIGHT - ROW_GAP * (n - 1)) / n))) : 0;
  const bars: CcOverviewCardBar[] = timeline
    ? timeline.bars.map((b) => {
        const seg = barSegments(b);
        return {
          offset: pxSpan(timeline, [timeline.start, b.from - 1]).width,
          served: pxSpan(timeline, seg.served).width,
          rest: pxSpan(timeline, seg.rest).width,
          active: b.standing === 'Active',
        };
      })
    : [];
  return {
    accent: BRAND_ACCENT,
    title: 'Constitutional Committee',
    subtitle: parts.join(', '),
    bars,
    rowHeight,
    rowGap: ROW_GAP,
    nowX: timeline ? pxSpan(timeline, [timeline.start, timeline.now - 1]).width : null,
  };
}

export function ccOverviewCardVersion(m: CcOverviewCardModel): string {
  return ogCardVersion(['cc-overview', m.subtitle, m.nowX ?? '', ...m.bars.flatMap((b) => [b.offset, b.served, b.rest, b.active ? 1 : 0])]);
}
