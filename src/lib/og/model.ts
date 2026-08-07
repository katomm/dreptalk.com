// Pure display models for the OG cards: map a governance action / DRep plus its
// pre-computed stats into the exact strings, colours and tally the templates
// render. No I/O and no network config (the caller passes expiry-in-ms and the
// avatar data URL), so this is unit-testable in isolation.

import { epochCountdown, headlineComposition, readableType, statusBadge } from '../governance/view.js';
import type { RowVotingInput } from '../governance/view.js';
import { excerptFromHtml, truncateIdMiddle } from '../forum/view.js';
import { computeVotingPowerDelta, formatTrendPct, absLovelace } from '../dreps/votingPowerTrend.js';
import { formatAda, formatAdaCompact } from '../format/ada.js';
import { isoDate } from '../format/date.js';
import { getCategory } from '../../../config/categories.js';
import type { NclStatus } from '../governance/ncl.js';
import { voteDisplay } from '../governance/voteStatement.js';
import { accentForType, BRAND_ACCENT, statusColor, tint, TALLY, MUTED } from './theme.js';

/** Hard character caps so a long title/name can never overflow the fixed canvas.
    When it has to cut, it prefers the last word boundary within the limit so the
    ellipsis never lands mid-word (falls back to a hard cut if the only space is
    far from the limit). */
function clamp(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max - 1).trimEnd();
  const space = slice.lastIndexOf(' ');
  const cut = space > max * 0.6 ? slice.slice(0, space) : slice;
  return `${cut.trimEnd()}…`;
}

export interface GovCardInput extends RowVotingInput {
  status: string;
  title: string | null;
  abstract: string | null;
  expiryEpoch: number | null;
}

export interface GovCardModel {
  accent: string;
  typeLabel: string;
  title: string;
  subtitle: string | null;
  status: { label: string; color: string; tint: string };
  meta: string;
  // Number-led headline: the leading body's Yes-of-eligible share. Denominator-independent
  // (the stored ratification pct), so no non-voting stake is ever mislabeled as No.
  tally: { yesPct: number; role: string } | null;
}

export function govCardModel(
  a: GovCardInput,
  opts: { expiryUnixMs: number | null; now: number; proposerName?: string | null },
): GovCardModel {
  const badge = statusBadge(a.status);
  const tone = statusColor(badge.tone);
  const countdown = epochCountdown(a.expiryEpoch, opts.expiryUnixMs, a.status, opts.now);
  const meta = [countdown, opts.proposerName ? `by ${opts.proposerName}` : null]
    .filter(Boolean)
    .join(', ');
  const t = headlineComposition(a);

  return {
    accent: accentForType(a.type),
    typeLabel: readableType(a.type),
    title: clamp(a.title?.trim() || readableType(a.type), 96),
    // The metadata abstract as a subtitle under the title, mirroring the DRep bio.
    subtitle: a.abstract ? excerptFromHtml(a.abstract, 140) : null,
    status: { label: badge.label, color: tone, tint: tint(tone) },
    meta,
    tally: t ? { yesPct: t.yesPct, role: t.role } : null,
  };
}

// One added/removed committee member: the resolved self-declared name (null when
// unknown) and the shortened cold-key label the detail page shows as a fallback.
export interface CommitteeMemberInput {
  name: string | null;
  label: string;
}

export interface CommitteeCardInput {
  type: string;
  status: string;
  title: string | null;
  expiryEpoch: number | null;
  added: CommitteeMemberInput[];
  removed: CommitteeMemberInput[];
  threshold: string | null;
}

export interface CommitteeColumnRow {
  text: string;
  // A cold-key fallback (no resolved name) renders muted, so named seats read as
  // the headline and anonymous ones stay legible but secondary.
  muted: boolean;
}
export interface CommitteeColumn {
  rows: CommitteeColumnRow[];
  extra: number;
}
export interface CommitteeCardModel {
  accent: string;
  typeLabel: string;
  title: string;
  status: { label: string; color: string; tint: string };
  meta: string;
  threshold: string | null;
  joining: CommitteeColumn;
  leaving: CommitteeColumn;
}

// At most four names per column so the tallest case still clears the bottom
// accent bar; a longer list keeps the first four and counts the rest as "+N more".
const MAX_COMMITTEE_ROWS = 4;
function committeeColumn(list: CommitteeMemberInput[]): CommitteeColumn {
  const rows = list.slice(0, MAX_COMMITTEE_ROWS).map((m) => {
    const name = m.name?.trim();
    return { text: name ? clamp(name, 26) : clamp(m.label, 26), muted: !name };
  });
  return { rows, extra: Math.max(0, list.length - MAX_COMMITTEE_ROWS) };
}

// Committee membership change as a share card: who joins, who leaves and the new
// vote threshold, instead of the generic Yes-of-eligible tally (near-meaningless
// for a committee action, where the eligible body is tiny). Same status/countdown
// grammar as govCardModel so the two stay consistent.
export function committeeCardModel(
  a: CommitteeCardInput,
  opts: { expiryUnixMs: number | null; now: number; proposerName?: string | null },
): CommitteeCardModel {
  const badge = statusBadge(a.status);
  const tone = statusColor(badge.tone);
  const countdown = epochCountdown(a.expiryEpoch, opts.expiryUnixMs, a.status, opts.now);
  const meta = [countdown, opts.proposerName ? `by ${opts.proposerName}` : null].filter(Boolean).join(', ');
  return {
    accent: accentForType(a.type),
    typeLabel: readableType(a.type),
    title: clamp(a.title?.trim() || readableType(a.type), 72),
    status: { label: badge.label, color: tone, tint: tint(tone) },
    meta,
    threshold: a.threshold,
    joining: committeeColumn(a.added),
    leaving: committeeColumn(a.removed),
  };
}

export interface DrepCardInput {
  drepId: string;
  name: string | null;
  bio: string | null;
  votingPower: number | string | null;
  active: boolean;
  status: string;
  registeredEpoch: number | null;
}

export type DrepStatIcon = 'power' | 'votes' | 'participation' | 'epoch';

export interface DrepStat {
  value: string;
  label: string;
  icon: DrepStatIcon;
}

export interface DrepCardModel {
  accent: string;
  name: string;
  idShort: string | null;
  bio: string | null;
  avatarDataUrl: string;
  stats: DrepStat[];
}

export function drepCardModel(
  d: DrepCardInput,
  opts: {
    avatarDataUrl: string;
    influencePct: number | null;
    votesCast: number;
    participation: { eligible: number; voted: number } | null;
  },
): DrepCardModel {
  const hasName = !!d.name?.trim();
  const idShort = truncateIdMiddle(d.drepId);
  const statusLabel = d.active ? 'Active DRep' : d.status === 'deregistered' ? 'Retired' : d.status;

  const stats: DrepStat[] = [
    {
      // The ada sign (U+20B3) renders via the bundled single-glyph fallback font
      // (see fonts.ts), since it is absent from the Plus Jakarta Sans subset.
      value: formatAdaCompact(d.votingPower) ?? '0 ₳',
      label: opts.influencePct != null ? `voting power (${opts.influencePct.toFixed(2)}%)` : 'voting power',
      icon: 'power',
    },
    { value: String(opts.votesCast), label: 'votes cast', icon: 'votes' },
  ];
  if (opts.participation && opts.participation.eligible > 0) {
    const pct = Math.round((opts.participation.voted / opts.participation.eligible) * 100);
    stats.push({ value: `${pct}%`, label: 'participation', icon: 'participation' });
  }
  stats.push(
    d.registeredEpoch != null
      ? { value: `Epoch ${d.registeredEpoch}`, label: statusLabel, icon: 'epoch' }
      : { value: statusLabel, label: '', icon: 'epoch' },
  );

  return {
    accent: BRAND_ACCENT,
    name: hasName ? clamp(d.name as string, 40) : idShort,
    idShort: hasName ? idShort : null,
    bio: d.bio ? excerptFromHtml(d.bio, 120) : null,
    avatarDataUrl: opts.avatarDataUrl,
    stats,
  };
}

export interface DiscussionCardInput {
  title: string;
  categorySlug: string;
  postCount: number;
  openingPostHtml: string | null;
}

export interface DiscussionCardModel {
  accent: string;
  category: string;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  avatarDataUrl: string | null;
  meta: string;
}

export function discussionCardModel(
  t: DiscussionCardInput,
  opts: { authorName: string | null; avatarDataUrl: string | null },
): DiscussionCardModel {
  const replies = Math.max(0, t.postCount - 1);
  return {
    accent: BRAND_ACCENT,
    category: getCategory(t.categorySlug)?.name ?? 'Discussion',
    title: clamp(t.title, 96),
    // The opening post as a subtitle under the title, mirroring the action abstract.
    subtitle: t.openingPostHtml ? excerptFromHtml(t.openingPostHtml, 140) : null,
    authorName: opts.authorName,
    avatarDataUrl: opts.avatarDataUrl,
    meta: `${replies} ${replies === 1 ? 'reply' : 'replies'}`,
  };
}

export interface HelpCardInput {
  title: string;
  description: string;
  category: string;
  updated?: Date;
}

// A help guide renders on the discussion card layout: the hub category as the
// pill, the frontmatter description as the subtitle, no author row, and the
// last-updated date (when the guide has one) in the meta line.
export function helpCardModel(g: HelpCardInput): DiscussionCardModel {
  return {
    accent: BRAND_ACCENT,
    category: g.category,
    // Tighter than the other cards: the illustration takes the right third, so
    // the title wraps in a ~720px column and a long one would run past three or
    // four lines into the description.
    title: clamp(g.title, 62),
    subtitle: excerptFromHtml(g.description, 140),
    authorName: null,
    avatarDataUrl: null,
    meta: g.updated ? `Help guide · Updated ${isoDate(g.updated)}` : 'Help guide',
  };
}

export interface TreasuryCardModel {
  accent: string;
  label: string;
  epochRange: string;
  pct: number;
  gaugeColor: string;
  headline: string;
  amounts: string;
}

// Brand purple used for the gauge fill (the light-mode value of --accent;
// satori cannot read CSS custom properties, so the hex is duplicated here).
const GAUGE_COLOR = '#6d28d9';

// Gauge fill clamps at 100% (an over-budget period cannot push the bar past
// its track). Always the brand accent color, matching the in-app NclPanel gauge.
export function treasuryCardModel(status: NclStatus): TreasuryCardModel {
  const { period } = status;
  const pct = Math.min(100, status.consumedPct);
  const consumed = formatAda(String(status.consumedLovelace)) ?? '0 ₳';
  const ceiling = formatAda(String(period.ceilingLovelace)) ?? '';
  const remaining = formatAda(String(status.remainingLovelace)) ?? '0 ₳';

  return {
    accent: accentForType('TreasuryWithdrawals'),
    label: period.label,
    epochRange: `Epochs ${period.startEpoch} to ${period.endEpoch}`,
    pct,
    gaugeColor: GAUGE_COLOR,
    headline: `${status.consumedPct}% consumed`,
    amounts: `${consumed} of ${ceiling}, ${remaining} remaining`,
  };
}

/** One DRep the endpoint has resolved to a display name plus its two snapshots. */
export interface MoverInput {
  name: string;
  snapshot: string | null;
  prev: string | null;
}

export interface MoverRow {
  name: string;
  /** Unsigned percent change, or null when the previous snapshot was zero. */
  pct: string | null;
  /** Absolute ada change, compact (e.g. "2.7M ₳"). */
  ada: string;
}

export interface MoversCardModel {
  accent: string;
  /** Pill label, e.g. "Epoch 643". */
  epochLabel: string;
  subtitle: string;
  gainers: MoverRow[];
  losers: MoverRow[];
}

// The delta strings come straight from the same trend helpers the directory chip
// uses, so the card and the page always agree. Name is clamped because each column
// gets roughly half the canvas beside the figure.
function moverRow(m: MoverInput): MoverRow {
  const delta = computeVotingPowerDelta(m.snapshot, m.prev);
  return {
    name: clamp(m.name, 22),
    pct: delta?.pct != null ? formatTrendPct(delta.pct) : null,
    ada: delta ? (formatAdaCompact(absLovelace(delta.deltaLovelace)) ?? '') : '',
  };
}

export function moversCardModel(input: {
  epoch: number | null;
  gainers: MoverInput[];
  losers: MoverInput[];
}): MoversCardModel {
  return {
    accent: BRAND_ACCENT,
    epochLabel: input.epoch != null ? `Epoch ${input.epoch}` : 'Latest epoch',
    subtitle:
      input.epoch != null
        ? `The biggest DRep voting-power shifts in epoch ${input.epoch}`
        : 'The biggest DRep voting-power shifts this epoch',
    gainers: input.gainers.map(moverRow),
    losers: input.losers.map(moverRow),
  };
}

export interface VoteCardInput {
  name: string | null;
  voterId: string;
  vote: string;
  rationaleText: string;
  actionTitle: string;
  role: 'DRep' | 'SPO';
}

export interface VoteCardModel {
  name: string;
  idShort: string | null;
  avatarDataUrl: string;
  /** Reads as a sentence after the name, e.g. "voted No" or "abstained". */
  votePhrase: string;
  voteColor: string;
  actionTitle: string;
  rationaleExcerpt: string;
  roleLabel: 'DRep' | 'SPO';
}

export function voteCardModel(v: VoteCardInput, opts: { avatarDataUrl: string }): VoteCardModel {
  const hasName = !!v.name?.trim();
  const idShort = truncateIdMiddle(v.voterId);
  const { tone } = voteDisplay(v.vote);
  const voteColor = tone === 'yes' ? TALLY.yes : tone === 'no' ? TALLY.no : MUTED;
  // Phrased to follow the name as a sentence: "<Name> voted No". Case-insensitive
  // because an optimistic just-cast vote is stored lowercase ("yes") while synced
  // votes are capitalized ("Yes"); both must read the same on the card.
  const vv = v.vote.trim().toLowerCase();
  const votePhrase = vv === 'yes' ? 'voted Yes' : vv === 'no' ? 'voted No' : vv === 'abstain' ? 'abstained' : 'voted';
  return {
    name: hasName ? clamp(v.name as string, 40) : idShort,
    idShort: hasName ? idShort : null,
    avatarDataUrl: opts.avatarDataUrl,
    votePhrase,
    voteColor,
    actionTitle: clamp(v.actionTitle, 90),
    rationaleExcerpt: clamp(v.rationaleText, 200),
    roleLabel: v.role,
  };
}
