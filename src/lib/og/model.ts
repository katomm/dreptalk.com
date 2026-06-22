// Pure display models for the OG cards: map a governance action / DRep plus its
// pre-computed stats into the exact strings, colours and tally the templates
// render. No I/O and no network config (the caller passes expiry-in-ms and the
// avatar data URL), so this is unit-testable in isolation.

import { epochCountdown, overviewTally, readableType, statusBadge } from '../governance/view.js';
import type { RoleTallyInput } from '../governance/view.js';
import { excerptFromHtml, truncateIdMiddle } from '../forum/view.js';
import { formatAdaCompact } from '../format/ada.js';
import { getCategory } from '../../../config/categories.js';
import { accentForType, BRAND_ACCENT, statusColor, tint } from './theme.js';

/** Hard character caps so a long title/name can never overflow the fixed canvas. */
function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export interface GovCardInput extends RoleTallyInput {
  title: string | null;
  expiryEpoch: number | null;
}

export interface GovCardModel {
  accent: string;
  typeLabel: string;
  title: string;
  status: { label: string; color: string; tint: string };
  meta: string;
  tally: { yes: number; no: number; abstain: number; role: string } | null;
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
  const t = overviewTally(a);

  return {
    accent: accentForType(a.type),
    typeLabel: readableType(a.type),
    title: clamp(a.title?.trim() || readableType(a.type), 96),
    status: { label: badge.label, color: tone, tint: tint(tone) },
    meta,
    tally: t ? { yes: t.bar.yes, no: t.bar.no, abstain: t.bar.abstain, role: t.role } : null,
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
}

export interface DiscussionCardModel {
  accent: string;
  category: string;
  title: string;
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
    authorName: opts.authorName,
    avatarDataUrl: opts.avatarDataUrl,
    meta: `${replies} ${replies === 1 ? 'reply' : 'replies'}`,
  };
}
